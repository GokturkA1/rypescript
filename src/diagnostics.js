// diagnostics.js

export class DiagnosticReporter {
  constructor() {
    this.sources = new Map(); // filePath -> fileContent
    this.errors = [];
    this.warnings = [];
  }

  registerSource(filePath, sourceCode) {
    this.sources.set(filePath, sourceCode);
  }

  getLineAndColumn(source, offset) {
    let line = 1;
    let col = 1;
    let lineStart = 0;

    for (let i = 0; i < offset && i < source.length; i++) {
      if (source[i] === "\n") {
        line++;
        col = 1;
        lineStart = i + 1;
      } else {
        col++;
      }
    }

    let lineEnd = source.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = source.length;
    const lineSnippet = source.substring(lineStart, lineEnd);

    return { line, col, lineSnippet };
  }

  addError(filePath, node, message, hintNode = null, hintMessage = null) {
    this.errors.push({ filePath, node, message, hintNode, hintMessage });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  formatDiagnostic(diag) {
    const source = this.sources.get(diag.filePath) || "";
    const start = diag.node?.start ?? diag.node?.span?.start ?? 0;
    const end = diag.node?.end ?? diag.node?.span?.end ?? start + 1;
    const len = Math.max(1, end - start);

    const { line, col, lineSnippet } = this.getLineAndColumn(source, start);

    const red = "\x1b[1;31m";
    const cyan = "\x1b[36m";
    const blue = "\x1b[34m";
    const bold = "\x1b[1m";
    const reset = "\x1b[0m";

    let out = `${red}error[E]: ${diag.message}${reset}\n`;
    out += `  ${cyan}-->${reset} ${diag.filePath}:${line}:${col}\n`;
    out += `   ${blue}|${reset}\n`;
    out += `${String(line).padStart(2, " ")} ${blue}|${reset}   ${lineSnippet}\n`;
    out += `   ${blue}|${reset}   ${" ".repeat(col - 1)}${red}${"^".repeat(len)} ${diag.message}${reset}\n`;

    if (diag.hintNode && diag.hintMessage) {
      const hStart = diag.hintNode.start ?? diag.hintNode.span?.start ?? 0;
      const hEnd = diag.hintNode.end ?? diag.hintNode.span?.end ?? hStart + 1;
      const hLen = Math.max(1, hEnd - hStart);
      const hInfo = this.getLineAndColumn(source, hStart);

      out += `   ${blue}|${reset}\n`;
      out += `${String(hInfo.line).padStart(2, " ")} ${blue}|${reset}   ${hInfo.lineSnippet}\n`;
      out += `   ${blue}|${reset}   ${" ".repeat(hInfo.col - 1)}${cyan}${"-".repeat(hLen)} ${diag.hintMessage}${reset}\n`;
    }

    out += `   ${blue}|${reset}\n`;
    return out;
  }

  printAll() {
    for (const err of this.errors) {
      console.error(this.formatDiagnostic(err));
    }
    if (this.errors.length > 0) {
      console.error(
        `\x1b[1;31mDerleme Hatası:\x1b[0m ${this.errors.length} adet semantik hata tespit edildi. Derleme durduruldu.\n`
      );
    }
  }
}