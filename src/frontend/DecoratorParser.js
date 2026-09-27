// src/frontend/DecoratorParser.js

/**
 * Top-level function ve interface decorator'larını kaynak metin uzunluğunu
 * ve satır düzenini bozmadan boşlukla maskeleyen ve toplayan katman.
 */
export class DecoratorParser {
  static parseTopLevelDecorators(rawSource) {
    const syntheticDecoratorsMap = new Map();
    const topLevelDecBlockRegex =
      /(?:export\s+)?((?:@(?:[a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\([^)]*?\))?\s*)+)(?:export\s+)?(?:async\s+)?(?:function|interface)\s+([a-zA-Z0-9_$]+)/g;
    let match;
    let tsSource = rawSource;

    while ((match = topLevelDecBlockRegex.exec(rawSource)) !== null) {
      const decBlock = match[1];
      const targetName = match[2];
      const decBlockStart = rawSource.indexOf(decBlock, match.index);
      const blockLen = decBlock.length;

      const singleDecRegex = /@([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\(\s*["']?([^"')\s]*)["']?\s*\))?/g;
      let dMatch;
      const decList = [];
      while ((dMatch = singleDecRegex.exec(decBlock)) !== null) {
        decList.push({ name: dMatch[1], arg: dMatch[2] || null });
      }
      if (decList.length > 0) {
        syntheticDecoratorsMap.set(targetName, decList);
      }

      // Kaynak metin uzunluğunu ve satırları bozmadan sadece boşlukla değiştir
      let mask = "";
      for (let i = 0; i < blockLen; i++) {
        mask += decBlock[i] === "\n" ? "\n" : " ";
      }
      tsSource = tsSource.substring(0, decBlockStart) + mask + tsSource.substring(decBlockStart + blockLen);
    }

    return { maskedSource: tsSource, syntheticDecoratorsMap };
  }
}
