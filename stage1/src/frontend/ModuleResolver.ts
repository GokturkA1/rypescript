// stage1/src/frontend/ModuleResolver.ts
import "../../../bin/liboxc_parser.so";

import { File } from "../std/fs.ts";
import { dirname, basename, extname, join, normalize } from "../std/path.ts";
import { println, eprintln } from "../std/io.ts";
import { Process } from "../std/process.ts";
import { DecoratorParser } from "./DecoratorParser.ts";

export declare function oxc_parse(filePath: pointer, sourceText: pointer): pointer;
export declare function oxc_free_string(ptr: pointer): void;

export class StringNode {
  val: string;
  next: StringNode;

  constructor(val: string) {
    this.val = val;
    this.next = null;
  }
}

function strEquals(a: string, b: string): boolean {
  if (a === b) return true;
  let len: number = a.length;
  if (len !== b.length) return false;
  for (let i: number = 0; i < len; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return false;
  }
  return true;
}

export class ModuleInfo {
  filePath: string;
  fileName: string;
  astJson: string;
  isEntry: boolean;
  next: ModuleInfo;

  constructor(filePath: string, fileName: string, astJson: string, isEntry: boolean) {
    this.filePath = filePath;
    this.fileName = fileName;
    this.astJson = astJson;
    this.isEntry = isEntry;
    this.next = null;
  }
}

export class ResolveResult {
  firstModule: ModuleInfo;
  lastModule: ModuleInfo;
  moduleCount: number;

  firstNativeLib: StringNode;
  lastNativeLib: StringNode;
  nativeLibCount: number;

  firstHeader: StringNode;
  lastHeader: StringNode;
  headerCount: number;

  visitedHead: StringNode;

  constructor() {
    this.firstModule = null;
    this.lastModule = null;
    this.moduleCount = 0;

    this.firstNativeLib = null;
    this.lastNativeLib = null;
    this.nativeLibCount = 0;

    this.firstHeader = null;
    this.lastHeader = null;
    this.headerCount = 0;

    this.visitedHead = null;
  }

  isVisited(path: string): boolean {
    let curr = this.visitedHead;
    while (curr !== null) {
      if (strEquals(curr.val, path)) {
        return true;
      }
      curr = curr.next;
    }
    return false;
  }

  addVisited(path: string): void {
    let node = new StringNode(path);
    node.next = this.visitedHead;
    this.visitedHead = node;
  }

  addModule(m: ModuleInfo): void {
    if (this.firstModule === null) {
      this.firstModule = m;
      this.lastModule = m;
    } else {
      this.lastModule.next = m;
      this.lastModule = m;
    }
    this.moduleCount = this.moduleCount + 1;
  }

  addNativeLib(l: string): void {
    let curr = this.firstNativeLib;
    while (curr !== null) {
      if (strEquals(curr.val, l)) return;
      curr = curr.next;
    }
    let node = new StringNode(l);
    if (this.firstNativeLib === null) {
      this.firstNativeLib = node;
      this.lastNativeLib = node;
    } else {
      this.lastNativeLib.next = node;
      this.lastNativeLib = node;
    }
    this.nativeLibCount = this.nativeLibCount + 1;
  }

  addHeaderFile(h: string): void {
    let curr = this.firstHeader;
    while (curr !== null) {
      if (strEquals(curr.val, h)) return;
      curr = curr.next;
    }
    let node = new StringNode(h);
    if (this.firstHeader === null) {
      this.firstHeader = node;
      this.lastHeader = node;
    } else {
      this.lastHeader.next = node;
      this.lastHeader = node;
    }
    this.headerCount = this.headerCount + 1;
  }
}

export class ModuleResolver {
  static extractImportsFromOxcJson(jsonStr: string, outImports: string[]): number {
    let importCount: number = 0;
    let pos: number = 0;
    let len: number = jsonStr.length;

    let target: string = "\"ImportDeclaration\"";
    let tLen: number = target.length;
    let srcKey: string = "\"source\":";
    let sLen: number = srcKey.length;
    let valKey: string = "\"value\":\"";
    let vLen: number = valKey.length;

    let importIdx: number = -1;
    let srcIdx: number = -1;
    let valIdx: number = -1;
    let limit: number = 0;
    let vLimit: number = 0;
    let endQuote: number = 0;
    let match: boolean = false;
    let i: number = 0;
    let j: number = 0;

    while (pos < len && importCount < outImports.length) {
      importIdx = -1;
      for (i = pos; i <= len - tLen; i++) {
        match = true;
        for (j = 0; j < tLen; j++) {
          if (jsonStr.charCodeAt(i + j) !== target.charCodeAt(j)) {
            match = false;
            break;
          }
        }
        if (match) {
          importIdx = i;
          break;
        }
      }

      if (importIdx === -1) break;

      srcIdx = -1;
      limit = importIdx + 10000;
      if (limit > len - sLen) limit = len - sLen;

      for (i = importIdx + tLen; i < limit; i++) {
        match = true;
        for (j = 0; j < sLen; j++) {
          if (jsonStr.charCodeAt(i + j) !== srcKey.charCodeAt(j)) {
            match = false;
            break;
          }
        }
        if (match) {
          srcIdx = i;
          break;
        }
      }

      if (srcIdx !== -1) {
        valIdx = -1;
        vLimit = srcIdx + 200;
        if (vLimit > len - vLen) vLimit = len - vLen;

        for (i = srcIdx + sLen; i < vLimit; i++) {
          match = true;
          for (j = 0; j < vLen; j++) {
            if (jsonStr.charCodeAt(i + j) !== valKey.charCodeAt(j)) {
              match = false;
              break;
            }
          }
          if (match) {
            valIdx = i + vLen;
            break;
          }
        }

        if (valIdx !== -1) {
          endQuote = valIdx;
          while (endQuote < len && jsonStr.charCodeAt(endQuote) !== 34) { // '"'
            endQuote = endQuote + 1;
          }
          let specifier: string = jsonStr.slice(valIdx, endQuote);
          outImports[importCount] = specifier;
          importCount = importCount + 1;
          pos = endQuote;
        } else {
          pos = srcIdx + sLen;
        }
      } else {
        pos = importIdx + tLen;
      }
    }

    return importCount;
  }

  static hasSyntaxErrors(jsonStr: string): boolean {
    let errKey: string = "\"errors\":[";
    let idx: number = -1;
    let len: number = jsonStr.length;
    let kLen: number = errKey.length;
    let match: boolean = false;
    let j: number = 0;

    for (let i: number = 0; i <= len - kLen; i++) {
      match = true;
      for (j = 0; j < kLen; j++) {
        if (jsonStr.charCodeAt(i + j) !== errKey.charCodeAt(j)) {
          match = false;
          break;
        }
      }
      if (match) {
        idx = i + kLen;
        break;
      }
    }

    if (idx !== -1 && idx < len) {
      if (jsonStr.charCodeAt(idx) !== 93) { // ']'
        return true;
      }
    }
    return false;
  }

  static resolve(entryFile: string): ResolveResult {
    let result = new ResolveResult();
    let normalizedEntry: string = normalize(entryFile);
    ModuleResolver.visit(normalizedEntry, normalizedEntry, result);
    if (result.lastModule !== null) {
      result.lastModule.isEntry = true;
    }
    return result;
  }

  static visit(currentPath: string, entryFile: string, result: ResolveResult): void {
    if (result.isVisited(currentPath)) return;
    result.addVisited(currentPath);

    if (!File.exists(currentPath)) {
      eprintln("[ModuleResolver] Modül dosyası bulunamadı: " + currentPath);
      Process.exit(1);
    }

    let readRes = File.readText(currentPath);
    if (!readRes.ok) {
      eprintln("[ModuleResolver] Dosya okuma hatası: " + currentPath);
      Process.exit(1);
    }
    let rawSource: string = readRes.value;

    let decRes = DecoratorParser.parseTopLevelDecorators(rawSource);
    let maskedSource: string = decRes.maskedSource;

    let resPtr: pointer = oxc_parse(currentPath as pointer, maskedSource as pointer);
    if (resPtr === null) {
      eprintln("[ModuleResolver] oxc_parse null döndürdü: " + currentPath);
      Process.exit(1);
    }

    let jsonStr: string = resPtr as string;

    if (ModuleResolver.hasSyntaxErrors(jsonStr)) {
      eprintln("[ModuleResolver] Syntax Hatası: " + basename(currentPath));
      oxc_free_string(resPtr);
      Process.exit(1);
    }

    let dir: string = dirname(currentPath);
    let importBuf: string[] = [
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", "",
      "", "", "", "", "", "", "", ""
    ];
    let importCount: number = ModuleResolver.extractImportsFromOxcJson(jsonStr, importBuf);

    for (let i: number = 0; i < importCount; i++) {
      let specifier: string = importBuf[i];
      let targetFile: string = join(dir, specifier);

      if (specifier.length > 2 && specifier.slice(specifier.length - 2, specifier.length) === ".h") {
        result.addHeaderFile(targetFile);
        continue;
      }

      let isSo: boolean = specifier.length > 3 && specifier.slice(specifier.length - 3, specifier.length) === ".so";
      let isA: boolean = specifier.length > 2 && specifier.slice(specifier.length - 2, specifier.length) === ".a";
      let isDylib: boolean = specifier.length > 6 && specifier.slice(specifier.length - 6, specifier.length) === ".dylib";

      if (isSo || isA || isDylib) {
        result.addNativeLib(targetFile);
        continue;
      }

      let ext: string = extname(targetFile);
      if (ext !== ".ts" && ext !== ".js") {
        if (File.exists(targetFile + ".ts")) {
          targetFile = targetFile + ".ts";
        } else if (File.exists(targetFile + ".js")) {
          targetFile = targetFile + ".js";
        }
      }

      ModuleResolver.visit(targetFile, entryFile, result);
    }

    let baseName: string = basename(currentPath);
    let isEntry: boolean = strEquals(currentPath, entryFile);
    let mod = new ModuleInfo(currentPath, baseName, jsonStr, isEntry);
    result.addModule(mod);
  }
}
