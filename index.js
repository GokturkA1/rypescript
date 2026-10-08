// index.js
import fs from "node:fs";
import path from "node:path";
import { ModuleResolver } from "./src/frontend/ModuleResolver.js";
import { SemanticAnalyzer } from "./src/semantics/SemanticAnalyzer.js";
import { MLIRBuilder } from "./src/ir/MLIRBuilder.js";
import { ASTLowering } from "./src/ir/ASTLowerer.js";
import { CompilerEngine } from "./src/engine/CompilerEngine.js";
import { TargetManager } from "./src/engine/TargetManager.js";
import { DiagnosticReporter } from "./src/diagnostics.js";

const args = process.argv.slice(2);

let inputFile = null;
let outputFile = "app_native";
let rawTarget = null;
let rawFormat = null;
let dumpMLIR = false;
let dumpLLVM = false;
let isJIT = false;
let explicitHeaderFile = null;
let genHeader = false;
let linkMode = "dynamic";
const extraLibDirs = [];
const extraLibs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-o" && i + 1 < args.length) {
    outputFile = args[++i];
  } else if ((arg === "--target" || arg === "-t") && i + 1 < args.length) {
    rawTarget = args[++i];
  } else if ((arg === "--format" || arg === "-f") && i + 1 < args.length) {
    rawFormat = args[++i];
  } else if (arg === "--standalone") {
    linkMode = "standalone";
  } else if (arg === "--static") {
    linkMode = "static";
  } else if (arg === "--dynamic") {
    linkMode = "dynamic";
  } else if (arg === "--dump-mlir") {
    dumpMLIR = true;
  } else if (arg === "--dump-llvm") {
    dumpLLVM = true;
  } else if (arg === "--jit") {
    isJIT = true;
  } else if (arg === "--header") {
    genHeader = true;
    if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
      explicitHeaderFile = args[++i];
    }
  } else if (arg.startsWith("-L")) {
    const dir = arg.length > 2 ? arg.slice(2) : args[++i];
    extraLibDirs.push(dir);
  } else if (arg.startsWith("-l")) {
    const lib = arg.length > 2 ? arg.slice(2) : args[++i];
    extraLibs.push(lib);
  } else if (!arg.startsWith("-") && !inputFile) {
    inputFile = arg;
  }
}

if (!inputFile || !fs.existsSync(inputFile)) {
  console.log("Kullanım: node index.js <giris_dosyasi.ts> [-o <cikti>] [--target <triple>] [--format <format>] [--standalone] [--static] [--dynamic] [--dump-mlir] [--dump-llvm] [--jit] [--header]");
  process.exit(1);
}

// Target ve Cross-Compilation Bilgisini Çöz
const targetInfo = TargetManager.resolve({
  target: rawTarget,
  format: rawFormat,
  outputFile,
  jit: isJIT,
  linkMode,
});

console.log(`[RTS] Giriş noktası: ${inputFile}`);
console.log(`[RTS] Hedef Triplet: ${targetInfo.triple} [Format: ${targetInfo.format}, Linker: ${targetInfo.linkerFlavor}, Mod: ${targetInfo.linkMode}]`);

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

const analyzer = new SemanticAnalyzer(modules, reporter, headerFiles);
analyzer.analyze();

if (reporter.hasErrors()) {
  reporter.printAll();
  process.exit(1); // Hata varsa kod üretimine geçmeden anında dur
}

// 2. Lowering: C Başlıkları + Çoklu AST -> Tek MLIR Modülü
const builder = new MLIRBuilder(targetInfo);
const lowerer = new ASTLowering(builder);

// C Header'larını yükle
for (const h of headerFiles) {
  lowerer.loadCHeader(h);
}

lowerer.lowerModules(modules);
const mlirModule = builder.buildFullModule({ targetInfo });

if (dumpMLIR) {
  console.log("\n=== Üretilen MLIR ===\n" + mlirModule);
}

// 3. Backend Motoru: MLIR -> LLVM -> Native Executable / Cross Binary / JIT
CompilerEngine.compile(mlirModule, outputFile, { dumpLLVM, jit: isJIT, targetInfo, nativeLibs, extraLibDirs, extraLibs, linkMode });
if (!isJIT) {
  console.log(`✓ Başarılı: ./${outputFile} [Format: ${targetInfo.format}, Hedef: ${targetInfo.triple}]`);

  // C Header Üretimi (--header bayrağı verildiğinde veya hedef .so/.dll olduğunda)
  const shouldGenHeader = genHeader || targetInfo.isShared;
  if (shouldGenHeader) {
    let headerFile = explicitHeaderFile;
    if (!headerFile) {
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