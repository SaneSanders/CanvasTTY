import type { LocaleId, PageElement, RemarkAnchor, ScenarioStep, Size } from "../../../shared/contracts";
import { anchorRect } from "./imageRegions.ts";
import { formatClock } from "../../../shared/materials.ts";

export const HANDOFF_TEXT_LIMIT = 16_000;
export const EXCERPT_LINE_LIMIT = 40;
export const EXCERPT_CHAR_LIMIT = 4_000;

export type HandoffImageMode = "claude" | "codex" | "paths";

export interface HandoffTextExcerpt {
  start: number;
  end: number;
  lines: string[];
  truncated: boolean;
}

export interface HandoffTextTarget {
  name: string;
  versionNumber: number;
  anchor: RemarkAnchor;
  natural: Size | null;
  file: string;
  marked: string | null;
  crop: string | null;
  location: string | null;
  excerpt: HandoffTextExcerpt | null;
  page: HandoffTextPage | null;
  scenario: HandoffTextScenario | null;
}

export interface HandoffTextPage {
  url: string;
  title: string;
  viewport: Size;
  elements: PageElement[];
}

export interface HandoffTextScenario {
  viewport: Size | null;
  steps: Array<ScenarioStep & { file: string | null }>;
  focus: number | null;
}

export interface HandoffTextRemark {
  number: number;
  text: string;
  target: HandoffTextTarget;
  reference: HandoffTextTarget | null;
}

export interface HandoffTextImage {
  name: string;
  path: string;
}

export interface HandoffTextInput {
  locale: LocaleId;
  number: number;
  folder: string;
  remarks: HandoffTextRemark[];
  editable: string[];
  note: string;
  resultsFolder: string | null;
  reportFile: string | null;
  imageMode: HandoffImageMode;
  images: HandoffTextImage[];
}

const STRINGS = {
  ru: {
    header: (number: number, count: number) => `CanvasTTY · передача #${number} · замечаний: ${count}`,
    folder: "Файлы передачи (снимки версий и выделения) лежат в папке:",
    editable: "Эти рабочие файлы можно менять:",
    onlyEditable: "Остальные файлы — только для справки, их не меняй.",
    noEditable: "Исходные файлы не меняй — новые варианты сохраняй отдельными файлами.",
    version: "версия",
    source: "Исходный файл:",
    snapshot: "Снимок версии:",
    marked: "Кадр с выделением:",
    crop: "Фрагмент крупно:",
    reference: "Референс:",
    requirement: "Требование:",
    note: "Дополнительно:",
    whole: "всё целиком",
    region: (rect: string, size: string) => `область ${rect} из ${size} px`,
    point: (x: number, y: number, size: string) => `точка (${x}, ${y}) из ${size} px`,
    regionShare: (x: string, y: string) => `область: по ширине ${x}, по высоте ${y}`,
    pointShare: (x: string, y: string) => `точка: по ширине ${x}, по высоте ${y}`,
    line: (line: number) => `строка ${line}`,
    moment: (time: string) => `момент ${time}`,
    pdfPage: (page: number) => `страница ${page}`,
    step: (step: number) => `шаг ${step}`,
    thisStep: " ← к этому шагу замечание",
    span: (start: string, end: string) => `отрезок ${start}–${end}`,
    frame: (time: string, name: string) => `Кадр ${time} из ${name}`,
    lines: (start: number, end: number) => `строки ${start}–${end}`,
    excerpt: "Эти строки в той версии:",
    excerptCut: "(фрагмент обрезан — полный текст в снимке версии)",
    page: (url: string, title: string, size: string) => `Страница: ${url}${title ? ` «${title}»` : ""}, окно ${size}`,
    elements: "Элементы страницы в этой области:",
    recording: (count: number, size: string | null) => `Запись во встроенном браузере: шагов ${count}${size ? `, окно ${size}` : ""}. Шаги — то, что видел CanvasTTY; строки «Ожидается» — слова человека.`,
    wholeRecording: "вся запись",
    opened: (url: string, title: string) => `Открыта ${url}${title ? ` «${title}»` : ""}`,
    clicked: (target: string, x: number, y: number) => `Нажатие ${target}в точке (${x}, ${y})`,
    navigated: (url: string, title: string) => `Страница сменилась на ${url}${title ? ` «${title}»` : ""}`,
    expected: (text: string) => `Ожидается (слова человека): «${text}»`,
    tabLeft: "Ушли на другую вкладку — там шаги не записывались",
    tabReturned: "Вернулись на записываемую вкладку",
    screenshot: "снимок",
    finish: (numbers: string) => `Когда закончишь, ответь, какие замечания (${numbers}) считаешь исправленными и что изменил.`,
    results: "Новые файлы результата сохраняй в папку",
    resultsTail: "— CanvasTTY покажет их на холсте.",
    report: "Отчёт запиши в",
    reportShape: "в виде {\"fixed\":[номера],\"note\":\"что сделано\"}.",
    attached: "Приложенные изображения по порядку:",
    open: "Изображения (открой их):",
    pointer: (number: number) => `CanvasTTY · передача #${number}: полный текст замечаний в файле`,
    pointerTail: "— прочитай его целиком."
  },
  en: {
    header: (number: number, count: number) => `CanvasTTY · handoff #${number} · remarks: ${count}`,
    folder: "Handoff files (version snapshots and highlights) are in:",
    editable: "You may change these working files:",
    onlyEditable: "The other files are for reference only — do not change them.",
    noEditable: "Do not change the source files — save new variants as separate files.",
    version: "version",
    source: "Source file:",
    snapshot: "Version snapshot:",
    marked: "Frame with the highlight:",
    crop: "Close-up:",
    reference: "Reference:",
    requirement: "Requirement:",
    note: "Also:",
    whole: "the whole file",
    region: (rect: string, size: string) => `area ${rect} of ${size} px`,
    point: (x: number, y: number, size: string) => `point (${x}, ${y}) of ${size} px`,
    regionShare: (x: string, y: string) => `area ${x} across, ${y} down`,
    pointShare: (x: string, y: string) => `point ${x} across, ${y} down`,
    line: (line: number) => `line ${line}`,
    moment: (time: string) => `at ${time}`,
    pdfPage: (page: number) => `page ${page}`,
    step: (step: number) => `step ${step}`,
    thisStep: " ← the remark is about this step",
    span: (start: string, end: string) => `${start}–${end}`,
    frame: (time: string, name: string) => `Frame at ${time} of ${name}`,
    lines: (start: number, end: number) => `lines ${start}–${end}`,
    excerpt: "These lines in that version:",
    excerptCut: "(excerpt cut — the full text is in the version snapshot)",
    page: (url: string, title: string, size: string) => `Page: ${url}${title ? ` “${title}”` : ""}, viewport ${size}`,
    elements: "Page elements in this area:",
    recording: (count: number, size: string | null) => `Recorded in the built-in browser: ${count} steps${size ? `, viewport ${size}` : ""}. Steps are what CanvasTTY saw; “Expected” lines are the person's words.`,
    wholeRecording: "the whole recording",
    opened: (url: string, title: string) => `Opened ${url}${title ? ` “${title}”` : ""}`,
    clicked: (target: string, x: number, y: number) => `Clicked ${target}at (${x}, ${y})`,
    navigated: (url: string, title: string) => `The page changed to ${url}${title ? ` “${title}”` : ""}`,
    expected: (text: string) => `Expected (the person's words): “${text}”`,
    tabLeft: "Left for another tab — steps there were not recorded",
    tabReturned: "Came back to the recorded tab",
    screenshot: "screenshot",
    finish: (numbers: string) => `When you are done, reply which remarks (${numbers}) you consider fixed and what you changed.`,
    results: "Save new result files into",
    resultsTail: "and CanvasTTY shows them on the canvas.",
    report: "Write the report to",
    reportShape: "as {\"fixed\":[numbers],\"note\":\"what was done\"}.",
    attached: "Attached images, in order:",
    open: "Images (open them):",
    pointer: (number: number) => `CanvasTTY · handoff #${number}: the full remarks are in`,
    pointerTail: "— read it completely."
  }
} as const;

export function describeAnchor(anchor: RemarkAnchor, natural: Size | null, locale: LocaleId, recording = false): string {
  const strings = STRINGS[locale];
  if (anchor.kind === "lines") return anchor.start === anchor.end ? strings.line(anchor.start) : strings.lines(anchor.start, anchor.end);
  if (anchor.kind === "page") return strings.pdfPage(anchor.page);
  if (anchor.kind === "step") return strings.step(anchor.index + 1);
  if (anchor.kind === "time") return anchor.end === null ? strings.moment(formatClock(anchor.start)) : strings.span(formatClock(anchor.start), formatClock(anchor.end));
  if (anchor.kind === "whole") return natural === null && recording ? strings.wholeRecording : strings.whole;
  if (!natural) {
    return anchor.kind === "point"
      ? strings.pointShare(share(anchor.x), share(anchor.y))
      : strings.regionShare(`${share(anchor.x)}–${share(anchor.x + anchor.width)}`, `${share(anchor.y)}–${share(anchor.y + anchor.height)}`);
  }
  const size = `${natural.width}×${natural.height}`;
  if (anchor.kind === "point") {
    return strings.point(Math.round(anchor.x * natural.width), Math.round(anchor.y * natural.height), size);
  }
  const rect = anchorRect(anchor, natural);
  return strings.region(`x ${rect.x}–${rect.x + rect.width}, y ${rect.y}–${rect.y + rect.height}`, size);
}

export function terminalSafe(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function inline(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/g, " ").replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

export function handoffText(input: HandoffTextInput): string {
  const strings = STRINGS[input.locale];
  const lines: string[] = [strings.header(input.number, input.remarks.length), "", strings.folder, code(input.folder)];
  if (input.editable.length > 0) {
    lines.push("", strings.editable, ...input.editable.map((path) => `- ${code(path)}`), strings.onlyEditable);
  } else {
    lines.push("", strings.noEditable);
  }
  for (const remark of input.remarks) {
    const target = remark.target;
    lines.push("", `#${remark.number} · ${inline(target.name)}, ${strings.version} ${target.versionNumber} · ${describeAnchor(target.anchor, target.natural, input.locale, target.scenario !== null)}`);
    if (target.location) lines.push(`${strings.source} ${code(target.location)}`);
    lines.push(`${strings.snapshot} ${code(target.file)}`);
    if (target.marked) lines.push(`${strings.marked} ${code(target.marked)}`);
    if (target.crop) lines.push(`${strings.crop} ${code(target.crop)}`);
    if (target.excerpt) lines.push(...excerptBlock(target.excerpt, input.locale));
    if (target.page) lines.push(...pageLines(target.page, input.locale));
    if (target.scenario) lines.push(...scenarioLines(target.scenario, input.locale));
    if (remark.reference) {
      const reference = remark.reference;
      const details = [
        `${inline(reference.name)}, ${strings.version} ${reference.versionNumber}`,
        describeAnchor(reference.anchor, reference.natural, input.locale),
        reference.crop ? `${strings.crop} ${code(reference.crop)}` : `${strings.snapshot} ${code(reference.file)}`
      ];
      lines.push(`${strings.reference} ${details.join(" · ")}`);
      if (reference.excerpt) lines.push(...excerptBlock(reference.excerpt, input.locale));
    }
    lines.push(`${strings.requirement} ${remark.text}`);
  }
  if (input.note.trim()) lines.push("", `${strings.note} ${input.note.trim()}`);
  lines.push("", strings.finish(input.remarks.map((remark) => `#${remark.number}`).join(", ")));
  if (input.resultsFolder) {
    lines.push(`${strings.results} ${code(input.resultsFolder)} ${strings.resultsTail}`);
    if (input.reportFile) lines.push(`${strings.report} ${code(input.reportFile)} ${strings.reportShape}`);
  }
  return terminalSafe(lines.join("\n") + imageBlock(input));
}

export function handoffPointerText(input: HandoffTextInput, handoffFile: string): string {
  const strings = STRINGS[input.locale];
  return terminalSafe(`${strings.pointer(input.number)} ${code(handoffFile)} ${strings.pointerTail}` + imageBlock(input));
}

function imageBlock(input: HandoffTextInput): string {
  if (input.images.length === 0) return "";
  const strings = STRINGS[input.locale];
  const names = `${strings.attached} ${input.images.map((image, index) => `${index + 1}) ${code(image.name)}`).join(" ")}`;
  if (input.imageMode === "claude") return `\n\n${names}\n${input.images.map((image) => image.path).join("\n")}`;
  if (input.imageMode === "codex") return `\n\n${names}`;
  return `\n\n${strings.open}\n${input.images.map((image) => `- ${code(image.path)}`).join("\n")}`;
}

function pageLines(page: HandoffTextPage, locale: LocaleId): string[] {
  const strings = STRINGS[locale];
  const lines = [strings.page(code(page.url), inline(page.title), `${Math.round(page.viewport.width)}×${Math.round(page.viewport.height)}`)];
  if (page.elements.length > 0) {
    lines.push(`${strings.elements} ${page.elements.map((element) => `${inline(element.role)} ${quoted(element.name, locale)}`).join(", ")}`);
  }
  return lines;
}

function scenarioLines(scenario: HandoffTextScenario, locale: LocaleId): string[] {
  const strings = STRINGS[locale];
  const size = scenario.viewport ? `${Math.round(scenario.viewport.width)}×${Math.round(scenario.viewport.height)}` : null;
  return [strings.recording(scenario.steps.length, size), ...scenario.steps.map((step, index) => {
    const shot = step.file ? ` — ${strings.screenshot} ${code(step.file)}` : "";
    return `${index + 1}. ${stepText(step, locale)}${shot}${scenario.focus === index ? strings.thisStep : ""}`;
  })];
}

function stepText(step: ScenarioStep, locale: LocaleId): string {
  const strings = STRINGS[locale];
  const url = step.url ? code(step.url) : "—";
  switch (step.kind) {
    case "start": return strings.opened(url, inline(step.title ?? ""));
    case "navigate": return strings.navigated(url, inline(step.title ?? ""));
    case "expectation": return strings.expected(step.text ?? "");
    case "tab-left": return strings.tabLeft;
    case "tab-returned": return strings.tabReturned;
    default: {
      const target = step.element ? `${inline(step.element.role)} ${quoted(step.element.name, locale)} ` : "";
      return strings.clicked(target, Math.round(step.point?.x ?? 0), Math.round(step.point?.y ?? 0));
    }
  }
}

function quoted(value: string, locale: LocaleId): string {
  return locale === "ru" ? `«${inline(value)}»` : `“${inline(value)}”`;
}

function share(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function excerptLines(text: string, start: number, end: number): HandoffTextExcerpt | null {
  const all = text.split("\n");
  if (start < 1 || start > all.length) return null;
  const last = Math.min(end, all.length);
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (let index = start - 1; index < last; index += 1) {
    const line = all[index];
    if (lines.length >= EXCERPT_LINE_LIMIT || used + line.length > EXCERPT_CHAR_LIMIT) {
      if (lines.length === 0) lines.push(line.slice(0, EXCERPT_CHAR_LIMIT));
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { start, end: last, lines, truncated };
}

function excerptBlock(excerpt: HandoffTextExcerpt, locale: LocaleId): string[] {
  const strings = STRINGS[locale];
  const longest = Math.max(0, ...excerpt.lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const width = String(excerpt.start + excerpt.lines.length - 1).length;
  const numbered = excerpt.lines.map((line, index) => `${String(excerpt.start + index).padStart(width)} | ${line}`);
  return [strings.excerpt, fence, ...numbered, fence, ...(excerpt.truncated ? [strings.excerptCut] : [])];
}

function code(value: string): string {
  return `\`${inline(value).replace(/`/g, "'")}\``;
}
