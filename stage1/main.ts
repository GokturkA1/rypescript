// stage1/main.ts
// RypeScript Compiler (Stage 1) - Native Binary CLI & Orchestrator

import { CommandLine, Process, process } from "./src/std/process.ts";
import { File } from "./src/std/fs.ts";
import { Path, basename, extname } from "./src/std/path.ts";
import { println, print, eprintln } from "./src/std/io.ts";
import { TargetManager, TargetInfo } from "./src/engine/TargetManager.ts";
import { CompilerEngine } from "./src/engine/CompilerEngine.ts";
import { ModuleResolver, ResolveResult, ModuleInfo } from "./src/frontend/ModuleResolver.ts";
import { SemanticAnalyzer } from "./src/semantics/SemanticAnalyzer.ts";
import { MLIRBuilder } from "./src/ir/MLIRBuilder.ts";
import { ASTLowering } from "./src/ir/ASTLowerer.ts";

export function printHelp(): void {
  println("RypeScript Native Compiler (Stage 1)");
  println("Kullanım: rypec <giris_dosyasi.ts> [-o <cikti>] [--target <triple>] [--format <format>] [--standalone] [--static] [--dynamic] [--dump-mlir] [--dump-llvm] [--jit] [--header]");
  println("");
  println("Seçenekler:");
  println("  -o <dosya>         Çıktı dosyasının adı (Varsayılan: app_native)");
  println("  -t, --target <tr.> Hedef mimari triple (ör: x86_64-pc-linux-gnu, wasm32-unknown-unknown)");
  println("  -f, --format <fmt> Çıktı formatı (elf, so, node, coff, exe, dll, wasm, macho, dylib)");
  println("  --standalone       Taşınabilir mod (özel bileşenleri ve C++ çalışma zamanını gömer)");
  println("  --static           Tam bağımsız mod (libc dahil her şeyi statik bağlar)");
  println("  --dynamic          Dinamik mod (Varsayılan, paylaşımlı kütüphaneleri kullanır)");
  println("  --dump-mlir        Üretilen MLIR kodunu ekrana bas");
  println("  --dump-llvm        Üretilen LLVM IR kodunu ekrana bas");
  println("  --jit              JIT modunda çalıştır");
  println("  --header [dosya]   C başlık (.h) dosyası üret");
  println("  -h, --help         Bu yardım iletisini göster");
}

export function main(args: string[]): i32 {
  let cli = CommandLine.parse(args);

  if (cli.hasFlag("--help") || cli.hasFlag("-h")) {
    printHelp();
    return 0;
  }

  let inputFile: string = "";
  let outputFile: string = "app_native";
  let rawTarget: string = "";
  let rawFormat: string = "";
  let linkMode: string = "dynamic";
  let dumpMLIR: boolean = cli.hasFlag("--dump-mlir");
  let dumpLLVM: boolean = cli.hasFlag("--dump-llvm");
  let isJIT: boolean = cli.hasFlag("--jit");

  // Parse arguments starting from 1 (skipping argv[0] program name)
  let count: number = args.length;
  for (let i: number = 1; i < count; i++) {
    let arg: string = args[i];
    if (arg === "-o" && i + 1 < count) {
      outputFile = args[i + 1];
      i = i + 1;
    } else if ((arg === "--target" || arg === "-t") && i + 1 < count) {
      rawTarget = args[i + 1];
      i = i + 1;
    } else if ((arg === "--format" || arg === "-f") && i + 1 < count) {
      rawFormat = args[i + 1];
      i = i + 1;
    } else if (arg === "--standalone") {
      linkMode = "standalone";
    } else if (arg === "--static") {
      linkMode = "static";
    } else if (arg === "--dynamic") {
      linkMode = "dynamic";
    } else if (arg.length > 0 && arg.charCodeAt(0) !== 45 && inputFile.length === 0) { // 45 = '-'
      inputFile = arg;
    }
  }

  if (inputFile.length === 0) {
    printHelp();
    return 1;
  }

  if (!File.exists(inputFile)) {
    eprintln("Hata: Giriş dosyası bulunamadı: " + inputFile);
    return 1;
  }

  let targetInfo: TargetInfo = TargetManager.resolve(rawTarget, rawFormat, outputFile, isJIT, linkMode);
  println("[RTS] Giriş noktası: " + inputFile);
  println("[RTS] Hedef Triplet: " + targetInfo.triple + " [Format: " + targetInfo.format + ", Linker: " + targetInfo.linkerFlavor + ", Mod: " + targetInfo.linkMode + "]");

  let res: ResolveResult = ModuleResolver.resolve(inputFile);
  if (res.lastModule !== null) {
    res.lastModule.isEntry = true;
  }

  print("[RTS] Bulunan modüller (" + res.moduleCount + "): ");
  let currMod = res.firstModule;
  while (currMod !== null) {
    print(currMod.fileName);
    currMod = currMod.next;
    if (currMod !== null) {
      print(" -> ");
    }
  }
  println("");
  let analyzer = new SemanticAnalyzer(res.firstModule);
  analyzer.analyze();

  let builder = new MLIRBuilder(targetInfo);
  let lowerer = new ASTLowering(builder);
  let mlirSource: string = lowerer.lowerModules(res.firstModule);
  if (dumpMLIR) {
    println("\n=== Üretilen MLIR ===\n" + mlirSource);
  }

  let nativeLibs: string[] = [];
  let ok: boolean = CompilerEngine.compile(mlirSource, outputFile, targetInfo, nativeLibs);
  if (!ok) {
    return 1;
  }

  println("✓ Başarılı: ./" + outputFile + " [Format: " + targetInfo.format + ", Hedef: " + targetInfo.triple + "]");
  return 0;
}
