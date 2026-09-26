// index.js
import fs from "node:fs";
import path from "node:path";
import { ModuleResolver } from "./src/frontend/ModuleResolver.js";
import { SemanticAnalyzer } from "./src/semantics/SemanticAnalyzer.js";
import { MLIRBuilder } from "./src/ir/MLIRBuilder.js";
import { ASTLowering } from "./src/ir/ASTLowerer.js";
import { CompilerEngine } from "./src/engine/CompilerEngine.js";
import { DiagnosticReporter } from "./diagnostics.js";

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

// 1. Modül Bağımlılık Grafı Çözücü (DFS / Topological Sort)
const { modules, nativeLibs, headerFiles } = ModuleResolver.resolve(inputFile);
console.log(`[RTS] Bulunan modüller (${modules.length}): ${modules.map((m) => m.fileName).join(" -> ")}`);
if (nativeLibs.length > 0) console.log(`[RTS] Bağlanacak Native Kütüphaneler: ${nativeLibs.map((l) => path.basename(l)).join(", ")}`);
if (headerFiles.length > 0) console.log(`[RTS] Ayrıştırılacak C Başlıkları: ${headerFiles.map((h) => path.basename(h)).join(", ")}`);

// 1.5. Semantik Analiz ve Derleme Zamanı Tip Kontrolü
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