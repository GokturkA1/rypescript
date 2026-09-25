// index.js
import { parseSync } from "oxc-parser";
import fs from "node:fs";
import path from "node:path";
import { MLIRBuilder } from "./mlir-builder.js";
import { ASTLowering } from "./ast-lowerer.js";
import { CompilerEngine } from "./compiler-engine.js";

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

  function visit(currentPath) {
    const absolutePath = path.resolve(currentPath);
    if (visited.has(absolutePath)) return;
    visited.add(absolutePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`[ModuleResolver] Modül dosyası bulunamadı: ${absolutePath}`);
    }

    const tsSource = fs.readFileSync(absolutePath, "utf8");
    const parsed = parseSync(absolutePath, tsSource);
    if (parsed.errors.length > 0) {
      console.error(`Syntax Hatası (${path.basename(absolutePath)}):`, parsed.errors);
      process.exit(1);
    }

    // AST içindeki tüm ImportDeclaration düğümlerini tara
    const dir = path.dirname(absolutePath);
    for (const node of parsed.program.body) {
      if (node.type === "ImportDeclaration") {
        const specifier = node.source.value;
        let targetFile = path.resolve(dir, specifier);

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
      isEntry: absolutePath === path.resolve(entryFile),
    });
  }

  visit(entryFile);
  return modules;
}

const modules = resolveModuleGraph(inputFile);
console.log(`[RTS] Bulunan modüller (${modules.length}): ${modules.map((m) => m.fileName).join(" -> ")}`);

// 2. Lowering: Çoklu AST -> Tek MLIR Modülü
const builder = new MLIRBuilder();
const lowerer = new ASTLowering(builder);
lowerer.lowerModules(modules);
const mlirModule = builder.buildFullModule();

if (dumpMLIR) {
  console.log("\n=== Üretilen MLIR ===\n" + mlirModule);
}

// 3. Backend Motoru: MLIR -> LLVM -> Native Executable / JIT
CompilerEngine.compile(mlirModule, outputFile, { dumpLLVM, jit: isJIT, format: targetFormat });
if (!isJIT) {
  console.log(`✓ Başarılı: ./${outputFile} [Format: ${targetFormat}]`);
}