// std/path.ts
// RypeScript Standart Kütüphanesi - Dosya Yolu Yardımcıları (Path)

function isSep(ch: number): boolean {
  return ch === 47 || ch === 92; // '/' or '\\'
}

export function basename(filePath: string): string {
  let len = filePath.length;
  if (len === 0) return "";

  let end = len;
  while (end > 0 && isSep(filePath.charCodeAt(end - 1))) {
    end = end - 1;
  }
  if (end === 0) {
    return "/";
  }

  let lastSlash = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (isSep(filePath.charCodeAt(i))) {
      lastSlash = i;
      break;
    }
  }

  if (lastSlash === -1) {
    return filePath.slice(0, end);
  }
  return filePath.slice(lastSlash + 1, end);
}

export function dirname(filePath: string): string {
  let len = filePath.length;
  if (len === 0) return ".";

  let end = len;
  while (end > 0 && isSep(filePath.charCodeAt(end - 1))) {
    end = end - 1;
  }
  if (end === 0) {
    return "/";
  }

  let lastSlash = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (isSep(filePath.charCodeAt(i))) {
      lastSlash = i;
      break;
    }
  }

  if (lastSlash === -1) {
    return ".";
  }
  if (lastSlash === 0) {
    return "/";
  }

  let dirEnd = lastSlash;
  while (dirEnd > 1 && isSep(filePath.charCodeAt(dirEnd - 1))) {
    dirEnd = dirEnd - 1;
  }
  return filePath.slice(0, dirEnd);
}

export function extname(filePath: string): string {
  let base = basename(filePath);
  let len = base.length;
  if (len <= 1) return "";

  let lastDot = -1;
  for (let i = len - 1; i >= 1; i--) {
    if (base.charCodeAt(i) === 46) { // '.' = 46
      lastDot = i;
      break;
    }
  }

  if (lastDot <= 0) {
    return "";
  }
  return base.slice(lastDot, len);
}

export function normalize(filePath: string): string {
  let len: number = filePath.length;
  if (len === 0) return ".";

  let isAbs: boolean = (filePath.charCodeAt(0) === 47); // '/'
  let parts: string[] = [
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", "",
    "", "", "", "", "", "", "", ""
  ];
  let partCount: number = 0;

  let pos: number = 0;
  while (pos < len) {
    while (pos < len && isSep(filePath.charCodeAt(pos))) {
      pos = pos + 1;
    }
    if (pos >= len) break;

    let start: number = pos;
    while (pos < len && !isSep(filePath.charCodeAt(pos))) {
      pos = pos + 1;
    }
    let segment: string = filePath.slice(start, pos);

    if (segment === ".") {
      // skip
    } else if (segment === "..") {
      if (partCount > 0 && parts[partCount - 1] !== "..") {
        partCount = partCount - 1;
      } else if (!isAbs) {
        if (partCount < parts.length) {
          parts[partCount] = "..";
          partCount = partCount + 1;
        }
      }
    } else {
      if (partCount < parts.length) {
        parts[partCount] = segment;
        partCount = partCount + 1;
      }
    }
  }

  if (partCount === 0) {
    return isAbs ? "/" : ".";
  }

  let res: string = isAbs ? "/" : "";
  for (let i: number = 0; i < partCount; i++) {
    if (i > 0 || isAbs) {
      if (i > 0) res = res + "/";
      res = res + parts[i];
    } else {
      res = parts[0];
    }
  }
  return res;
}

export function join(part1: string, part2: string): string {
  if (part1.length === 0) return normalize(part2);
  if (part2.length === 0) return normalize(part1);

  let hasTrailing = isSep(part1.charCodeAt(part1.length - 1));
  let hasLeading = isSep(part2.charCodeAt(0));

  let combined: string = "";
  if (hasTrailing && hasLeading) {
    combined = part1 + part2.slice(1, part2.length);
  } else if (!hasTrailing && !hasLeading) {
    combined = part1 + "/" + part2;
  } else {
    combined = part1 + part2;
  }
  return normalize(combined);
}

export class Path {
  static basename(filePath: string): string {
    return basename(filePath);
  }

  static dirname(filePath: string): string {
    return dirname(filePath);
  }

  static extname(filePath: string): string {
    return extname(filePath);
  }

  static normalize(filePath: string): string {
    return normalize(filePath);
  }

  static join(part1: string, part2: string): string {
    return join(part1, part2);
  }
}
