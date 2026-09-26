// src/frontend/ModuleResolver.js
import { parseSync } from "oxc-parser";
import fs from "node:fs";
import path from "node:path";
import { DecoratorParser } from "./DecoratorParser.js";

/**
 * Modül bağımlılık grafını çözen DFS / Topological Sort mekanizması.
 */
export class ModuleResolver {
  static resolve(entryFile) {
    const visited = new Set();
    const modules = [];
    const nativeLibs = new Set();
    const headerFiles = new Set();

    function visit(currentPath) {
      const absolutePath = path.resolve(currentPath);
      if (visited.has(absolutePath)) return;
      visited.add(absolutePath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`[ModuleResolver] Modül dosyası bulunamadı: ${absolutePath}`);
      }

      const rawSource = fs.readFileSync(absolutePath, "utf8");
      const { maskedSource, syntheticDecoratorsMap } = DecoratorParser.parseTopLevelDecorators(rawSource);

      const parsed = parseSync(absolutePath, maskedSource);
      if (parsed.errors.length > 0) {
        console.error(`Syntax Hatası (${path.basename(absolutePath)}):`, parsed.errors);
        process.exit(1);
      }

      // AST içindeki tüm ImportDeclaration düğümlerini tara ve grafı ziyaret et
      const dir = path.dirname(absolutePath);
      for (const node of parsed.program.body) {
        if (node.type === "ImportDeclaration") {
          const specifier = node.source.value;
          let targetFile = path.resolve(dir, specifier);

          // 1. C Başlık Dosyası İçe Aktarımı: import type ... from "./lib.h"
          if (specifier.endsWith(".h")) {
            headerFiles.add(targetFile);
            continue;
          }

          // 2. Dinamik/Statik Native Kütüphane: import ... from "./lib.so"
          if (specifier.endsWith(".so") || specifier.endsWith(".dylib") || specifier.endsWith(".a")) {
            nativeLibs.add(targetFile);
            const companionH = targetFile.replace(/\.(so|dylib|a)$/, ".h");
            if (fs.existsSync(companionH)) {
              headerFiles.add(companionH);
            }
            continue;
          }

          if (!targetFile.endsWith(".ts") && !targetFile.endsWith(".js")) {
            if (fs.existsSync(targetFile + ".ts")) targetFile += ".ts";
            else if (fs.existsSync(targetFile + ".js")) targetFile += ".js";
          }
          visit(targetFile);
        }
      }

      modules.push({
        filePath: absolutePath,
        fileName: path.basename(absolutePath),
        program: parsed.program,
        comments: parsed.comments || [],
        syntheticDecorators: syntheticDecoratorsMap,
        isEntry: absolutePath === path.resolve(entryFile),
      });
    }

    visit(entryFile);
    return {
      modules,
      nativeLibs: Array.from(nativeLibs),
      headerFiles: Array.from(headerFiles),
    };
  }
}
