# Архитектура

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md) · [简体中文](ARCHITECTURE.zh-CN.md)

## Обновление приложения

Main-процесс владеет единым `UpdateService` и состояниями `idle`, `checking`, `available`, `downloading`, `ready`, `installing`, `upToDate`, `error`. Preload открывает доверенному renderer только `check`, `download`, `install`, текущий снимок и подписку на статусы; пути к файлам и команды установки через IPC не принимаются. Источник — только стабильные релизы `howdeploy/CanvasTTY`. Проверка выполняется через 30 секунд после запуска и затем раз в час либо вручную. Скачивание и установка запускаются только пользователем.

На macOS адаптер сохраняет архив до запуска Sparkle. Sparkle 2 проверяет Ed25519-подпись подписанного appcast и архива перед заменой приложения. На Windows NSIS и Linux AppImage/deb используется `electron-updater` без автоматического скачивания и установки при выходе. Portable Windows ведёт пользователя к релизу для ручной установки.

## Диагностика приложения

`DiagnosticLog` ведёт ограниченный журнал событий в `userData/logs`: четыре JSONL-файла по 1 МиБ. Он фиксирует запуск и завершение, ошибки main/renderer, сбои IPC, состояния сессий и обновлений. Вывод PTY и ввод пользователя не собираются. Секреты маскируются существующим safety registry перед записью и перед отправкой.

`diagnosticIpc` принимает обращения только от доверенного главного frame. Отчёт отправляется по явной кнопке через HTTPS на адрес из manifest и требует подтверждения своего идентификатора. Самостоятельный приёмник и инструкция подключения домена находятся в [diagnostics.md](diagnostics.md). Автоматической отправки нет.

## Границы процессов

CanvasTTY использует трёхслойную модель Electron:

```text
React renderer
    │ типизированный API window.canvasTTY
    ▼
preload bridge (contextBridge)
    │ IPC-каналы из белого списка
    ▼
Electron main process
    ├── SettingsStore  → проверенное атомарное JSON-хранилище
    ├── TerminalManager → lifecycle node-pty, ограниченный scrollback и batching вывода
    ├── LimitsService  → очищенные adapters лимитов и кэш
    ├── PluginManager  → установка из GitHub, manifest, assets, permissions, storage
    ├── PluginSecretsService → защищённое системное шифрование credentials плагинов с fail-closed поведением
    ├── PluginMediaService → разрешённые медиапапки, ranged audio streams, плейлисты
    ├── BrowserService → встроенные вкладки и lifecycle изолированных WebContentsView
    ├── MaterialService → материалы холста: grants по realpath, live-состояние, версии, замечания, черновики, сценарии
    │   └── MaterialBlobs → content-addressed блобы версий и скриншотов под общей квотой
    ├── HandoffService / HandoffResults → пакеты передачи, проверенная доставка вставкой, ход turn, папки результатов
    ├── canvastty-plugin:// → статические plugin resources под CSP
    ├── canvastty-media:// → локальные аудиопотоки с проверкой разрешений
    ├── canvastty-material:// → read-only потоки материалов, версий и шагов сценария
    └── нативные dialogs/window controls
```

- `src/shared/contracts.ts` — единственный публичный контракт между процессами. Любое изменение межпроцессных данных сначала объявляется здесь.
- `src/preload/index.ts` открывает только типизированные возможности, нужные renderer. Node integration выключен, context isolation и sandbox включены.
- `src/main/ipc/registerIpc.ts` владеет нативными side effects и проверяет доступ к сохраняемым медиа.
- `src/main/services/TerminalManager.ts` — источник истины для живого состояния сессий и PTY buffers. Scrollback хранится в ограниченном chunk-буфере, а PTY data объединяются в IPC-пакеты по 16 мс. Обычный терминал стартует как `idle`, агент остаётся `unavailable` до первого машинного lifecycle-сигнала провайдера. После этого Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes и Grok Build переходят между `idle`, `working` и `needs_approval` по provider hooks; точные OSC 0/2 markers Claude/Qwen сохранены как fallback совместимости. Человекочитаемый terminal text и само существование PTY не считаются активностью. Завершение процесса даёт только `done` или `failed`.
- `src/main/services/LimitsService.ts` читает Codex через app-server protocol установленного CLI, а Claude, Kimi, OpenCode Go и Grok Build — через provider usage/billing endpoints. Qwen Code мультипровайдерный и не имеет provider-neutral quota-read protocol, поэтому его adapter честно возвращает `cli-not-found` или `unsupported-protocol`, не выдумывая проценты. Credentials читаются только в доверенном main-процессе, отправляются только соответствующему провайдеру по HTTPS, не логируются и не выходят через IPC. Сервис отвечает за timeout, structural normalization, cache, stale fallback и cleanup подпроцессов; сырые ответы провайдеров через IPC не проходят.
- `src/main/services/SettingsStore.ts` нормализует каждое изменение и сохраняет его сериализованной атомарной записью.
- `src/main/services/PluginManager.ts` устанавливает готовые статические репозитории без выполнения package scripts, отклоняет symlinks и слишком большие пакеты, хранит реестр включения, отдаёт только файлы внутри пакета и применяет permissions/storage quotas для каждого плагина.
- `src/main/services/PluginSecretsService.ts` сериализует запись секретов каждого плагина, шифрует весь ограниченный payload через Electron `safeStorage`, отклоняет plaintext-only backend и удаляет зашифрованный файл при uninstall. `ProviderSecretsService.ts` применяет ту же архитектуру к API-ключам провайдеров для CLI с BYOK: значения остаются в main-процессе, а renderer-контракт раскрывает только флаги `configured` и операции set/clear. Записи настроек `ApiProfile` именуют model-бэкенды (протокол, HTTPS base URL, ссылка на секрет) для тех же BYOK-рантаймов; это не agent providers, а normalizer настроек отбрасывает невалидные профили вместо «ремонта».
- `src/main/services/PluginMediaService.ts` сохраняет разрешения только после нативного выбора папки, скрывает абсолютные пути, пропускает symlinks и отдаёт аудио с HTTP Range. Чтение плейлистов остаётся внутри разрешённых библиотек; ограниченная атомарная запись разрешена только в `Playlists/`.
- `src/main/services/BrowserService.ts` владеет вкладками встроенного браузера в `WebContentsView`. Удалённые страницы используют отдельный persistent partition с выключенным Node, включёнными context isolation/sandbox и отклонением website permissions по умолчанию. Это core service, а не возможность runtime-плагина.
- `src/main/services/agent-runtime/` — отдельная всегда включённая lifecycle-граница, не зависящая от переключателя Browser access. Каждый agent PTY получает собственный capability для защищённого user-local socket/pipe. Provider command hooks и OpenCode event plugin могут передать только фиксированный status enum, ограниченное имя события и необязательный opaque turn/prompt ID; точная schema Gateway отклоняет prompt text, ответы, tool input и произвольную telemetry. При завершении PTY capability и временные файлы отзываются.
- Claude, Codex, Qwen и OpenCode получают lifecycle hooks только на текущий запуск. Для Kimi, Hermes и Grok, которые ищут hooks в home-конфигурации, используются ownership-checked временные записи с совместным владением живых сессий. Kimi и Hermes используют recovery journals и точные backups, Grok — отдельный owned hook file; cleanup восстанавливает исходные байты или удаляет только записи CanvasTTY при конкурентных изменениях.
- `TerminalManager` подмешивает MCP helper, не оставляя постоянных изменений в provider-конфигах. Claude Code, Codex и Qwen Code получают CLI arguments; Qwen получает одну inline-запись `--mcp-config`, которая переопределяет только имя сервера CanvasTTY и не скрывает сторонние user servers. OpenCode — объединённый launch-only `OPENCODE_CONFIG_CONTENT` с одной scoped browser-tool permission, Kimi — per-run MCP config или временную запись с compare-and-swap и recovery journal для старых версий. Hermes получает временную запись `mcp_servers.canvastty_browser` в `HERMES_HOME/config.yaml` (по умолчанию `~/.hermes/config.yaml` в POSIX или `%LOCALAPPDATA%\hermes\config.yaml` в Windows); чувствительные capability-значения остаются ссылками на окружение дочернего процесса. Временная конфигурация Kimi и Hermes живёт до завершения последней владеющей PTY-сессии, после чего исходные байты точно восстанавливаются, если файл не менялся параллельно. Journal восстанавливает Hermes после прерванного запуска при следующем старте CanvasTTY, а compare-and-swap сохраняет одновременные пользовательские изменения. Сторонние MCP-записи, credentials и file/shell permissions не затрагиваются. Qwen, OpenCode и Hermes YOLO остаются launch-only и не меняют постоянные permission-настройки.
- `src/main/services/providerCliRegistry.ts` — единственный владелец обнаружения provider CLI. При запуске main-процесса он создаёт общий snapshot для каждого провайдера из `PROVIDER_CLI_DEFINITIONS` — каждое определение объявляет имена executable-команд, под которыми провайдер может устанавливаться (они могут отличаться от ID провайдера, например провайдер с командой `mcode`), и опциональные известные каталоги (относительно home или Windows LOCALAPPDATA), — последовательно проверяя smoke-only overrides, унаследованный `PATH`, системные каталоги платформы и эти известные каталоги. Доступная запись хранит абсолютный executable, тип launcher-а и дополненный дочерний `PATH`; POSIX-кандидат обязан быть исполняемым файлом, а Windows-кандидат — поддерживаемым native или batch launcher-ом. `TerminalManager`, `LimitsService`, agent-browser probes и provider smoke используют один и тот же snapshot и не повторяют поиск команды. Недоступный CLI создаёт failed-сессию с копируемой диагностикой проверенных путей до создания PTY или временной browser-конфигурации, а адаптер лимитов сообщает `cli-not-found`; строка HOME скрыта до ручного выбора после обнаружения CLI. Провайдер без локального CLI остаётся в панелях запуска, если для него есть аккаунт на удалённом компьютере или сохранённый контейнерный профиль. CanvasTTY не читает shell startup scripts. Настройки агентов позволяют повторно проверить пути, атомарно заменить snapshot registry, согласовать сохранённые списки запуска и лимитов и обновить зависящие от CLI адаптеры без перезапуска. Работающие сессии продолжаются; найденный позже CLI остаётся выключенным до ручного выбора.

Основной `BrowserWindow` создаётся и показывается с лёгкой локальной стартовой страницей до инициализации settings, plugins, media и IPC. Успешная инициализация заменяет её доверенным renderer; bootstrap failure показывает видимую error page и сохраняет fallback на native dialog. Main process удерживает single-instance lock и восстанавливает/фокусирует существующее окно при повторном запуске.

Код runtime-плагина никогда не импортируется в main или доверенный renderer bundle. HOME widgets и canvas apps работают в sandboxed iframe с opaque origin. Отдельные plugin windows используют узкий preload, который пересылает тот же message SDK через IPC handler с проверкой фактического sender URL `canvastty-plugin://<id>/<entry>`. Произвольные нативные окна ОС не встраиваются.

Доступ плагина к музыке основан на capabilities, а не на общем доступе к файловой системе. Media scan возвращает library IDs, относительные пути, metadata и `canvastty-media://` stream URLs; сырой текст плейлиста остаётся единственным format-neutral содержимым файла. Media URL разрешается только включённому плагину-владельцу и только внутри ранее выбранного root библиотеки. Удаление плагина отзывает сохранённые folder grants.

Встроенный браузер разделён между поверхностями: `BrowserCard` рисует доверенный внешний chrome окна, вкладки, навигацию, agent badges, downloads, dialogs и canvas geometry, а `BrowserService` размещает активный native view поверх измеренного viewport карточки. Во время движения карточки или камеры native view остаётся live и получает coalesced geometry updates по кадрам; он скрывается только в semantic summary, при редактировании HOME и за trusted modal surfaces. Дробные renderer bounds расширяются до охватывающих device-independent pixels, а активный tab view переподключается только при фактической смене вкладки. Typed pointer bridge возвращает click/hover activity native page в canvas selection и явно восстанавливает фокус страницы, не блокируя её ввод. Само подключение или heartbeat не создаёт presence: badge появляется только после browser-команды, а cursor — только после появления реальной pointer position.

## Материалы, замечания и передачи

Материалы — это карточки локальных файлов и снимков на холсте. `src/main/services/materials/MaterialService.ts` владеет материалами, версиями, замечаниями и черновиками; `HandoffService.ts` собирает и доставляет пакеты передач; `HandoffResults.ts` наблюдает за папками результатов и читает `canvastty-report-<n>.json`. Renderer видит только ID, отображаемые пути и типизированные результаты в `src/renderer/src/features/materials/*`. Общие константы и лимиты — в `src/shared/materials.ts`. Байты файлов и версий отдаются только для чтения через `canvastty-material://` с поддержкой HTTP Range, `no-store` и `nosniff`.

Состояние хранится в `userData/materials/state.json` (`0600`, атомарно, с debounce) только при включённом **Сохранять материалы после выхода**. Текстовые черновики — отдельные файлы `0600` в `userData/materials/drafts/`. Если `state.json` не удаётся распарсить, он переносится в `state.json.broken-<timestamp>` и запускается с пустым состоянием. Версии — content-addressed блобы в `userData/materials/versions/`: не более 1 ГБ суммарно, до 256 МБ на версию, до 32 МБ на снимок, до 20 версий на материал. Видео и аудио больше 256 МБ возвращают явную ошибку и не версионируются. Закреплённые (pinned) версии не вытесняются; иначе при превышении лимита без предупреждения удаляются самые старые несвязанные версии, а когда удалять нечего, операция возвращает явную ошибку `version-limit`. Пакеты передач лежат в `userData/materials/handoffs/<id>/`: не более 50 папок, до 512 МБ на пакет и до 1 ГБ суммарно, чистка при старте и после каждой отправки. Выключенный переключатель **Сохранять материалы после выхода** очищает `versions/` и `handoffs/` при старте и при выходе, а состояние записывается пустым.

Перетащенный, выбранный или вставленный файл становится grant на его realpath. Каждое чтение заново открывает файл с `O_NOFOLLOW | O_NONBLOCK`, требует обычный файл и отказывает, если путь теперь ведёт в другое место. Идентичность файла — `dev`/`ino` из `stat`. Тот же контент с новым `mtime`/`ino` остаётся текущей версией; переименование, изменяющее только регистр букв, предлагается как «перемещён» после проверки того же inode и исключения symlink. Папка результатов передачи при каждом скане приводится к realpath, а при нечитаемом realpath наблюдение возвращается к последнему известному пути и снимается через десять минут после конца окна или при выходе приложения. Удаление карточки не трогает исходный файл; вместе с ней удаляются её закреплённые версии и снимки, существующие только в CanvasTTY. Правка текста сохраняется только если хеш на диске всё ещё равен базе правки (compare-and-swap), через временный файл и rename в той же папке с сохранением режима файла, окончаний строк и BOM; заменённое содержимое остаётся версией.

Просмотр никогда не исполняет содержимое файла с правами приложения. Изображения, видео и аудио идут через `canvastty-material://`. Текст декодируется как UTF-8 и выводится как текст. Байты PDF читаются в main через IPC и разбираются pdf.js в worker без скриптов, XFA и WebAssembly.

Замечание закрепляет точную версию и якорь: `whole`, `point`/`region` на изображении, `lines` в тексте, `time`/`span` в видео и аудио, `page` в PDF или `step` в сценарии. Замечаний не более 2000, текст каждого — не более 2000 символов. Выдержки текста сопровождаются номерами строк. Замечание может ссылаться на другой материал; проверяются обе стороны. `reported` приходит только из файла-отчёта агента, `accepted` — только от человека. Обновления атомарны через serial-очередь `MaterialService`.

Передача уходит в существующую терминальную сессию через `TerminalManager.deliverInput` как bracketed paste. Проверенная доставка — только для Claude Code и Codex: их текст и пути изображений вставляются и подтверждаются headless-зеркалом xterm перед нажатием Enter, либо отчётом `canvastty-report-<n>.json` в выбранной папке результатов. Прочим агентам передаётся только текст, без Enter, и итог — `pasted` с одной из причин `not-observed`, `not-seen` или `enter-failed`. Повторная отправка в сессию, которая уже отправляет, отбивается как `busy`, а повторное использование того же id передачи — как `already-sent`. Из текста удаляются управляющие символы терминала, полный текст всегда пишется в `handoff.md` пакета. Начало и конец turn берутся только из lifecycle-статуса того же запуска сессии; доставка не означает, что агент что-то прочитал или сделал.

Необязательная папка результатов наблюдается в окне turn передачи. Новые файлы становятся карточками результатов, а `canvastty-report-<n>.json` может перевести замечания в `reported`. Файл приписывается передаче, только если его изменение объясняет окно ровно одной передачи; иначе источник показывается неизвестным.

Снимок страницы и запись сценария пользуются только публичным renderer API браузера: `browser_screenshot`, `browser_observe`, `getState` и `onState`. Прямоугольник захвата меряется относительно `.browser-card__viewport`, который рендерит `BrowserCard`. Их UI находится вне карточки Browser. Запись явно включается и выключается, ограничена 30 шагами или 15 минутами и вкладкой, где началась, не записывает нажатия клавиш и хранит URL без query и fragment. Перед сохранением URL санитизируются: высокоэнтропийные сегменты пути заменяются на `…`. Пароли маскируются ядром браузера, но обычный текст в полях форм виден на скриншотах. Запись, пережившая renderer (например, после перезагрузки), закрывается таймером main с исходом `limit`. Кадры видео снимаются из видимого прямоугольника видео и передаются в `captureFrame`.

## Границы renderer

`App.tsx` — граница оркестрации. Он загружает settings/sessions, подписывается на события main process, координирует dialogs и persistence. Feature components не вызывают API несвязанных фич.

```text
App
├── WorkspaceCanvas        camera, pan, zoom, пространственная композиция
│   ├── HomeZone           сохраняемая сетка, граница и edit gestures
│   │   ├── homeModel      чистое получение строк лимитов/активных сессий
│   │   └── HomeMediaWidget независимые pick/replace/remove controls
│   ├── TerminalCard       xterm, selection, rename, drag, resize и snap
│   ├── PluginCanvasCard   sandboxed plugin app с bounds и summary
│   ├── MaterialCard       карточки файлов, снимков и сценариев: image, text, media, PDF и scenario с замечаниями
│   └── BrowserCard        доверенный browser chrome и geometry для native view
├── HandoffDialog          получатель, замечания, файлы, точный предпросмотр и итог доставки
├── CompareDialog          изображения до/после или построчный diff, затем принять или вернуть
├── AgentLaunchDialog      фиксированный provider + folder + profile + launch
└── SettingsPanel          General, Appearance, Controls и Plugins
    └── PluginSettingsSection preview, permissions, registry и contributions
```

Domain decisions остаются в чистых selectors вроде `homeModel.ts`, orchestration — в `App.tsx`, rendering/local interaction — в feature components. IPC calls принадлежат `App.tsx` или фиче, которая единолично владеет capability.

## Поток сессии

1. Home запрашивает терминал или открывает provider-specific launch card.
2. `App` отправляет типизированный запрос `terminal:create`.
3. `TerminalManager` проверяет запрос, запускает PTY, хранит metadata и ограниченный chunked scrollback, затем отправляет lifecycle events и data events пакетами по 16 мс.
4. `App` согласует lifecycle snapshots по session ID.
5. `TerminalCard` подписывается на PTY stream, отправляет PTY input/grid resize и фиксирует типизированные canvas bounds после drag или edge resize.

`SessionMetadata` владеет world-space position и размером карточки. `App` согласует bounds, а `TerminalCard` может хранить transient geometry pointer-move до pointer-up. Main process проверяет и ограничивает размеры до отправки session snapshot. Camera wheel обрабатывается только на пустом canvas; интерактивные поверхности сохраняют native scroll/input ownership.

Камера не является состоянием React. `App` владеет `cameraStore` (`features/workspace/cameraStore.ts`); `WorkspaceCanvas` пишет transform сцены из listener'а store синхронно, до рендера всего, что измеряет сцену. На каждое движение подписаны только миникарта и `BrowserCard`; карточки подписаны на производные значения (`useCameraSelector`: масштаб сводки, допуск WebGL), а обработчики перетаскивания читают `camera.get().zoom` в момент движения, поэтому pan или zoom не рендерят карточки.

Одна живая `TerminalCard` владеет одним xterm instance на всё время жизни session ID. Смена palette обновляет `terminal.options.theme` на месте; title/settings не должны пересоздавать terminal или его renderer scrollback. Window title обновляется как session metadata через `terminal:rename`. PTY input/resize, пришедшие одновременно с exit, сдерживаются на границе main process и не превращаются в uncaught Electron errors.

Batching вывода — граница IPC/rendering, а не истории: каждый PTY chunk сразу добавляется в ограниченный scrollback, а ожидающий renderer output сбрасывается по таймеру 16 мс, перед exit и перед dispose. Trimming двигается по chunks вместо пересборки всего буфера на каждую запись; snapshot объединяет только сохранённый suffix.

Координаты указателя терминала преобразуются из визуально трансформированного rectangle канваса обратно в layout coordinates xterm до selection/wheel handling. Направления колеса терминала и канваса независимо нормализуются из сохранённых settings. Выделенный текст копируется через типизированный clipboard bridge по `Ctrl+C`, `Ctrl+Shift+C` или `Cmd+C`; вставка использует `Ctrl+Shift+V`, `Cmd+V` или `Shift+Insert` и входит в xterm через `Terminal.paste`, а не synthetic keystrokes. `Shift+Enter` отправляет CSI-u modified Enter напрямую в PTY.

Application shortcuts нормализуются в `SettingsStore`, сопоставляются в `App` и отображаются из тех же сохранённых bindings в canvas hint. `App` владеет эксклюзивным selection canvas application и выбранной terminal session для действий вроде rename. `TerminalCard` владеет xterm focus и inline editor, `BrowserService` — focus native page. Нажатие на пустой canvas снимает любой selection. Опциональный hover focus использует одинаковую настроенную задержку entry/exit для терминалов и встроенного Browser; focus-in/focus-out sequences программного перехода терминала подавляются до PTY input, чтобы TUI агента не сбрасывал позицию истории.

Session counters, progress bars и statuses всегда выводятся из настоящих `SessionSnapshot`. UI не синтезирует telemetry.

## Поток лимитов провайдера

1. `App` запрашивает очищенный `LimitsSnapshot` при bootstrap и каждые 60 секунд.
2. `LimitsService` дедуплицирует refresh и хранит 60-секундный cache.
3. Codex опрашивается через `codex app-server` методом `account/rateLimits/read`. Claude, Kimi, OpenCode Go и Grok Build используют read-only usage/billing endpoints и credentials установленных CLI. Qwen Code возвращает явный unavailable reason: одна Qwen-сессия может работать с разными облачными или локальными провайдерами, а универсального quota-read protocol у CLI нет. OpenCode Go даёт настоящие rolling, weekly и monthly windows, Grok Build — настоящий общий billing period. Реальные ответы структурно проверяются и сокращаются до percentage, window и reset time.
4. Если refresh не удался после успешного чтения, последний валидный snapshot возвращается как stale. Отсутствующие/неподдерживаемые adapters возвращают явную unavailable reason, а не `0%`.
5. CanvasTTY запрашивает Claude usage с OAuth-токеном из CLI credentials текущего пользователя. Отсутствующие или нечитаемые credentials дают `not-authenticated`; локальное состояние credentials не считается доказательством отсутствия подписки. Provider TUI screens не разбираются.

## Точки расширения

- Новый provider добавляется в `ProviderId`, `providers.ts`, `TerminalManager.resolveLaunch`, карту официальных provider assets и опциональный безопасный limit adapter.
- Сохраняемая setting добавляется в `AppSettings`, defaults/normalization в `SettingsStore` и только во владеющую фичу. Settings владеет пользовательскими canvas controls и shortcuts; camera math и snapping geometry остаются чистыми renderer concerns.
- Canvas entity добавляется отдельным feature component с явной position и callbacks; camera ownership остаётся в `WorkspaceCanvas`.
- Новый вид материала добавляется через `MaterialKind` в `src/shared/contracts.ts`, затем в Record `KINDS` в `src/main/services/materials/materialState.ts` (typecheck потребует новый ключ). Добавь нормализацию в `normalizeMaterial`, отображение в `materialType` и запись в `DEFAULT_SIZES` в `src/shared/materials.ts`, исчерпывающие кейсы в `anchorFits` и `remarkAnchorLabel`, текст для `describeAnchor` в `src/main/services/materials/handoffText.ts` и body-компонент в `MaterialCard` в `src/renderer/src/features/materials/`.
- Runtime extension публикуется со статическими HTML/CSS/JS entries и `canvastty.plugin.json` API v1. Виды contributions: `home-widget`, `canvas-app`, `window`; capability access ограничен declared permissions. См. [Runtime-плагины](plugins.ru.md).

Каждое расширение должно пройти `npm run typecheck`, `npm run build` и проверку взаимодействия в настоящем Electron.
