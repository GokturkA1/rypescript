// stage1/src/frontend/DecoratorParser.ts
import { StringBuilder } from "../std/stringbuilder.ts";

export class DecoratorInfo {
  name: string;
  arg: string;

  constructor(name: string, arg: string) {
    this.name = name;
    this.arg = arg;
  }
}

export class ParseDecoratorsResult {
  maskedSource: string;
  targetNames: string[];
  decorators: DecoratorInfo[][];
  count: number;

  constructor(maskedSource: string) {
    this.maskedSource = maskedSource;
    this.targetNames = [
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", ""
    ];
    this.decorators = [
      null, null, null, null, null, null, null, null,
      null, null, null, null, null, null, null, null
    ];
    this.count = 0;
  }

  add(target: string, list: DecoratorInfo[]): void {
    if (this.count < this.targetNames.length) {
      this.targetNames[this.count] = target;
      this.decorators[this.count] = list;
      this.count = this.count + 1;
    }
  }

  getDecorators(target: string): DecoratorInfo[] {
    for (let i: number = 0; i < this.count; i++) {
      if (this.targetNames[i] === target) {
        return this.decorators[i];
      }
    }
    let empty: DecoratorInfo[] = [];
    return empty;
  }
}

export class DecoratorParser {
  static parseTopLevelDecorators(rawSource: string): ParseDecoratorsResult {
    let result = new ParseDecoratorsResult(rawSource);
    let len: number = rawSource.length;
    let sb = new StringBuilder(len);

    let inString: number = 0; // 0: none, 34: ", 39: ', 96: `
    let isLineStart: boolean = true;
    let i: number = 0;
    let decStart: number = 0;
    let decEnd: number = 0;
    let k: number = 0;
    while (i < len) {
      let ch: number = rawSource.charCodeAt(i);

      // Line comment //
      if (inString === 0 && ch === 47 && i + 1 < len && rawSource.charCodeAt(i + 1) === 47) {
        while (i < len && rawSource.charCodeAt(i) !== 10) {
          sb.appendChar(rawSource.charCodeAt(i));
          i = i + 1;
        }
        continue;
      }

      // Block comment /*
      if (inString === 0 && ch === 47 && i + 1 < len && rawSource.charCodeAt(i + 1) === 42) {
        sb.appendChar(rawSource.charCodeAt(i));
        i = i + 1;
        sb.appendChar(rawSource.charCodeAt(i));
        i = i + 1;
        while (i < len - 1 && !(rawSource.charCodeAt(i) === 42 && rawSource.charCodeAt(i + 1) === 47)) {
          if (rawSource.charCodeAt(i) === 10) isLineStart = true;
          sb.appendChar(rawSource.charCodeAt(i));
          i = i + 1;
        }
        if (i < len) {
          sb.appendChar(rawSource.charCodeAt(i));
          i = i + 1;
        }
        if (i < len) {
          sb.appendChar(rawSource.charCodeAt(i));
          i = i + 1;
        }
        continue;
      }

      if (inString !== 0) {
        if (ch === 92) { // escape '\'
          sb.appendChar(ch);
          i = i + 1;
          if (i < len) {
            sb.appendChar(rawSource.charCodeAt(i));
            i = i + 1;
          }
          continue;
        }
        if (ch === inString) {
          inString = 0;
        }
        sb.appendChar(ch);
        i = i + 1;
        continue;
      }

      if (ch === 34 || ch === 39 || ch === 96) { // '"', '\'', '`'
        inString = ch;
        isLineStart = false;
        sb.appendChar(ch);
        i = i + 1;
        continue;
      }

      if (ch === 10) { // '\n'
        isLineStart = true;
        sb.appendChar(ch);
        i = i + 1;
        continue;
      }

      if (ch === 32 || ch === 9 || ch === 13) { // space, tab, \r
        sb.appendChar(ch);
        i = i + 1;
        continue;
      }

      // Check for '@' at start of line
      if (ch === 64 && isLineStart) { // '@'
        decStart = i;
        decEnd = i;
        while (decEnd < len && rawSource.charCodeAt(decEnd) !== 10) {
          decEnd = decEnd + 1;
        }

        // Mask this decorator with whitespace
        for (k = decStart; k < decEnd; k++) {
          sb.appendChar(32); // ' '
        }
        i = decEnd;
        continue;
      }

      isLineStart = false;
      sb.appendChar(ch);
      i = i + 1;
    }

    result.maskedSource = sb.toString();
    return result;
  }
}
