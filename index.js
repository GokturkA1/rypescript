// index.js
import { parseSync } from "oxc-parser";
import fs from "node:fs";
import path from "node:path";
import { MLIRBuilder } from "./mlir-builder.js";
import { ASTLowering } from "./ast-lowerer.js";
import { CompilerEngine } from "./compiler-engine.js";
import { DiagnosticReporter } from "./diagnostics.js";
import { SemanticAnalyzer } from "./semantic-analyzer.js";

const args = process.argv.slice(2);
const inputFile = args.find((a) => !a.startsWith("-"));
if (!inputFile || !fs.existsSync(inputFile)) {
  console.log("Kullanım: node index.js <giris_dosyasi.ts> [-o <cikti>] [--dump-mlir] [--dump-llvm]");
  process.exit(1);
}

const outputFile = args.includes("-o") ? args[args.indexOf("-o") + 1] : "app_native";
const dumpMLIR = args.includes("--dump-mlir");
const dumpLLVM = args.includes("--dump-llvm");
const isJIT = args.includes("--jit");
const formatIdx = args.indexOf("--format");
const targetFormat = formatIdx !== -1 ? args[formatIdx + 1] : "elf";

console.log(`[RTS] Giriş noktası: ${inputFile}`);

// --- MODÜL BAĞIMLILIK GRAFI ÇÖZÜCÜ (DFS / Topological Sort) ---
function resolveModuleGraph(entryFile) {
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

    // Top-level function ve interface decorator'larını yakala ve aynı uzunlukta boşlukla maskele
    const syntheticDecoratorsMap = new Map();
    const topLevelDecBlockRegex = /((?:@(?:[a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\([^)]*?\))?\s*)+)(export\s+)?(function|interface)\s+([a-zA-Z0-9_$]+)/g;
    let match;
    let tsSource = rawSource;

    while ((match = topLevelDecBlockRegex.exec(rawSource)) !== null) {
      const decBlock = match[1];
      const targetName = match[4];
      const startIndex = match.index;
      const blockLen = decBlock.length;

      const singleDecRegex = /@([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\(\s*["']?([^"']*)["']?\s*\))?/g;
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
      tsSource = tsSource.substring(0, startIndex) + mask + tsSource.substring(startIndex + blockLen);
    }

    const parsed = parseSync(absolutePath, tsSource);
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
  return { modules, nativeLibs: Array.from(nativeLibs), headerFiles: Array.from(headerFiles) };
}

const { modules, nativeLibs, headerFiles } = resolveModuleGraph(inputFile);
console.log(`[RTS] Bulunan modüller (${modules.length}): ${modules.map((m) => m.fileName).join(" -> ")}`);
if (nativeLibs.length > 0) console.log(`[RTS] Bağlanacak Native Kütüphaneler: ${nativeLibs.map((l) => path.basename(l)).join(", ")}`);
if (headerFiles.length > 0) console.log(`[RTS] Ayrıştırılacak C Başlıkları: ${headerFiles.map((h) => path.basename(h)).join(", ")}`);

// 1.5. SEMANTİK ANALİZ VE DERLEME ZAMANI TİP KONTROLÜ
const reporter = new DiagnosticReporter();
for (const mod of modules) {
  const code = fs.readFileSync(mod.filePath, "utf8");
  reporter.registerSource(mod.filePath, code);
}

const analyzer = new SemanticAnalyzer(modules, reporter);
analyzer.analyze();

if (reporter.hasErrors()) {
  reporter.printAll();
  process.exit(1); // Hata varsa kod üretimine geçmeden anında dur
}

// 2. Lowering: C Başlıkları + Çoklu AST -> Tek MLIR Modülü
const builder = new MLIRBuilder();
const lowerer = new ASTLowering(builder);

// C Header'larını yükle
for (const h of headerFiles) {
  lowerer.loadCHeader(h);
}

lowerer.lowerModules(modules);
const mlirModule = builder.buildFullModule({ format: targetFormat });

if (dumpMLIR) {
  console.log("\n=== Üretilen MLIR ===\n" + mlirModule);
}

// 3. Backend Motoru: MLIR -> LLVM -> Native Executable / JIT
CompilerEngine.compile(mlirModule, outputFile, { dumpLLVM, jit: isJIT, format: targetFormat, nativeLibs });
if (!isJIT) {
  console.log(`✓ Başarılı: ./${outputFile} [Format: ${targetFormat}]`);

  // C Header Üretimi (--header bayrağı verildiğinde veya hedef .so olduğunda)
  const headerIdx = args.indexOf("--header");
  const shouldGenHeader = headerIdx !== -1 || targetFormat === "so";
  if (shouldGenHeader) {
    let headerFile;
    if (headerIdx !== -1 && args[headerIdx + 1] && !args[headerIdx + 1].startsWith("-")) {
      headerFile = args[headerIdx + 1];
    } else {
      const outExt = path.extname(outputFile);
      const base = outExt ? outputFile.slice(0, -outExt.length) : outputFile;
      headerFile = `${base}.h`;
    }
    const guardName = `${path.basename(headerFile).replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
    const headerCode = lowerer.generateCHeader(guardName);
    fs.writeFileSync(headerFile, headerCode, "utf8");
    console.log(`✓ C Header üretildi: ./${headerFile}`);
  }
}