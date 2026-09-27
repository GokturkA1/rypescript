// src/engine/CompilerEngine.js
import { dlopen, getRawPointer, suffix } from "node:ffi";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TargetManager } from "./TargetManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");

const libMLIR = existsSync("/usr/local/lib/libMLIR-C.so")
  ? "/usr/local/lib/libMLIR-C.so"
  : `/usr/lib/libMLIR-C.so`;

const libLLVM = existsSync("/usr/local/lib/libLLVM.so")
  ? "/usr/local/lib/libLLVM.so"
  : `/usr/lib/libLLVM.so`;

const { functions: mlir } = dlopen(libMLIR, {
  mlirContextCreate: { arguments: [], return: "pointer" },
  mlirContextDestroy: { arguments: ["pointer"], return: "void" },
  mlirDialectRegistryCreate: { arguments: [], return: "pointer" },
  mlirRegisterAllDialects: { arguments: ["pointer"], return: "void" },
  mlirRegisterAllPasses: { arguments: [], return: "void" },
  mlirRegisterAllLLVMTranslations: { arguments: ["pointer"], return: "void" },
  mlirContextAppendDialectRegistry: { arguments: ["pointer", "pointer"], return: "void" },
  mlirDialectRegistryDestroy: { arguments: ["pointer"], return: "void" },
  mlirContextLoadAllAvailableDialects: { arguments: ["pointer"], return: "void" },

  mlirModuleCreateParse: { arguments: ["pointer", "pointer", "uint64"], return: "pointer" },
  mlirModuleGetOperation: { arguments: ["pointer"], return: "pointer" },
  mlirOperationVerify: { arguments: ["pointer"], return: "bool" },
  mlirModuleDestroy: { arguments: ["pointer"], return: "void" },

  mlirPassManagerCreate: { arguments: ["pointer"], return: "pointer" },
  mlirPassManagerGetAsOpPassManager: { arguments: ["pointer"], return: "pointer" },
  mlirPassManagerDestroy: { arguments: ["pointer"], return: "void" },
  mlirPassManagerRunOnOp: { arguments: ["pointer", "pointer"], return: "uint8" },
  mlirOpPassManagerAddPipeline: {
    arguments: ["pointer", "pointer", "uint64", "pointer", "pointer"],
    return: "uint8",
  },

  mlirTranslateModuleToLLVMIR: { arguments: ["pointer", "pointer"], return: "pointer" },
});

// 3. LLVM C API (TargetMachine, Object Emitter ve MCJIT)
const { functions: llvm } = dlopen(libLLVM, {
  LLVMContextCreate: { arguments: [], return: "pointer" },
  LLVMContextDispose: { arguments: ["pointer"], return: "void" },
  LLVMPrintModuleToFile: { arguments: ["pointer", "pointer", "pointer"], return: "int32" },
  LLVMDisposeModule: { arguments: ["pointer"], return: "void" },

  // Target & TargetMachine API (X86 + WebAssembly + AArch64 + ARM + RISCV)
  LLVMInitializeX86TargetInfo: { arguments: [], return: "void" },
  LLVMInitializeX86Target: { arguments: [], return: "void" },
  LLVMInitializeX86TargetMC: { arguments: [], return: "void" },
  LLVMInitializeX86AsmPrinter: { arguments: [], return: "void" },

  LLVMInitializeWebAssemblyTargetInfo: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyTarget: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyTargetMC: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyAsmPrinter: { arguments: [], return: "void" },

  LLVMInitializeAArch64TargetInfo: { arguments: [], return: "void" },
  LLVMInitializeAArch64Target: { arguments: [], return: "void" },
  LLVMInitializeAArch64TargetMC: { arguments: [], return: "void" },
  LLVMInitializeAArch64AsmPrinter: { arguments: [], return: "void" },

  LLVMInitializeARMTargetInfo: { arguments: [], return: "void" },
  LLVMInitializeARMTarget: { arguments: [], return: "void" },
  LLVMInitializeARMTargetMC: { arguments: [], return: "void" },
  LLVMInitializeARMAsmPrinter: { arguments: [], return: "void" },
  LLVMGetDefaultTargetTriple: { arguments: [], return: "pointer" },
  LLVMGetTargetFromTriple: { arguments: ["pointer", "pointer", "pointer"], return: "int32" },
  LLVMCreateTargetMachine: {
    arguments: ["pointer", "pointer", "pointer", "pointer", "int32", "int32", "int32"],
    return: "pointer",
  },
  LLVMDisposeTargetMachine: { arguments: ["pointer"], return: "void" },
  LLVMTargetMachineEmitToFile: {
    arguments: ["pointer", "pointer", "pointer", "int32", "pointer"],
    return: "int32",
  },

  // MCJIT ExecutionEngine API
  LLVMLinkInMCJIT: { arguments: [], return: "void" },
  LLVMCreateMCJITCompilerForModule: {
    arguments: ["pointer", "pointer", "pointer", "uint64", "pointer"],
    return: "int32",
  },
  LLVMFindFunction: { arguments: ["pointer", "pointer", "pointer"], return: "int32" },
  LLVMRunFunction: { arguments: ["pointer", "pointer", "uint32", "pointer"], return: "pointer" },
  LLVMGenericValueToInt: { arguments: ["pointer", "int32"], return: "uint64" },
  LLVMDisposeGenericValue: { arguments: ["pointer"], return: "void" },
  LLVMDisposeExecutionEngine: { arguments: ["pointer"], return: "void" },
});

// 4. LLD In-Process Bridge (bridge.cpp)
const libBridge = existsSync(path.join(projectRoot, "libbridge.so"))
  ? path.join(projectRoot, "libbridge.so")
  : existsSync(path.join(__dirname, "libbridge.so"))
  ? path.join(__dirname, "libbridge.so")
  : existsSync("./libbridge.so")
  ? "./libbridge.so"
  : `/usr/lib/libbridge.so`;

const { functions: bridge } = dlopen(libBridge, {
  link_elf: { arguments: ["int32", "pointer"], return: "bool" },
  link_coff: { arguments: ["int32", "pointer"], return: "bool" },
  link_macho: { arguments: ["int32", "pointer"], return: "bool" },
  link_wasm: { arguments: ["int32", "pointer"], return: "bool" },
  link_mingw: { arguments: ["int32", "pointer"], return: "bool" },
});

export class CompilerEngine {
  static compile(mlirSource, outputFile, options = {}) {
    console.log("  -> [1/6] MLIR ve LLVM motoru başlatılıyor...");
    mlir.mlirRegisterAllPasses();

    const ctx = mlir.mlirContextCreate();
    const reg = mlir.mlirDialectRegistryCreate();
    mlir.mlirRegisterAllDialects(reg);
    mlir.mlirContextAppendDialectRegistry(ctx, reg);
    mlir.mlirDialectRegistryDestroy(reg);
    mlir.mlirContextLoadAllAvailableDialects(ctx);
    mlir.mlirRegisterAllLLVMTranslations(ctx);

    console.log("  -> [2/6] MLIR modülü ayrıştırılıyor...");
    const buf = Buffer.from(mlirSource, "utf8");
    const mod = mlir.mlirModuleCreateParse(ctx, buf, BigInt(buf.length));
    if (!mod) {
      mlir.mlirContextDestroy(ctx);
      throw new Error("[Engine] MLIR ayrıştırma hatası! Sözdizimi geçersiz.");
    }

    const op = mlir.mlirModuleGetOperation(mod);
    if (!mlir.mlirOperationVerify(op)) {
      mlir.mlirModuleDestroy(mod);
      mlir.mlirContextDestroy(ctx);
      throw new Error("[Engine] MLIR Operasyon doğrulaması başarısız!");
    }

    console.log("  -> [3/6] PassManager lowering pipeline yürütülüyor...");
    const pm = mlir.mlirPassManagerCreate(ctx);
    const opm = mlir.mlirPassManagerGetAsOpPassManager(pm);

    const pipelineStr = [
      "convert-scf-to-cf",
      "convert-cf-to-llvm",
      "convert-arith-to-llvm",
      "convert-func-to-llvm",
      "reconcile-unrealized-casts",
    ].join(",");

    const pipelineBuf = Buffer.from(pipelineStr, "utf8");
    const addStatus = mlir.mlirOpPassManagerAddPipeline(
      opm,
      pipelineBuf,
      BigInt(pipelineBuf.length),
      null,
      null
    );

    if (addStatus === 0) {
      mlir.mlirPassManagerDestroy(pm);
      mlir.mlirModuleDestroy(mod);
      mlir.mlirContextDestroy(ctx);
      throw new Error("[Engine] Pass pipeline oluşturulamadı!");
    }

    const runStatus = mlir.mlirPassManagerRunOnOp(pm, op);
    if (runStatus === 0) {
      mlir.mlirPassManagerDestroy(pm);
      mlir.mlirModuleDestroy(mod);
      mlir.mlirContextDestroy(ctx);
      throw new Error("[Engine] MLIR lowering pass'leri başarısız oldu!");
    }

    console.log("  -> [4/6] MLIR'dan LLVM IR modülüne çevriliyor...");
    console.log(`     MLIR Lib: ${libMLIR}`);
    console.log(`     LLVM Lib: ${libLLVM}`);

    const llvmCtx = llvm.LLVMContextCreate();
    const llvmMod = mlir.mlirTranslateModuleToLLVMIR(op, llvmCtx);
    if (!llvmMod) {
      mlir.mlirPassManagerDestroy(pm);
      mlir.mlirModuleDestroy(mod);
      mlir.mlirContextDestroy(ctx);
      llvm.LLVMContextDispose(llvmCtx);
      throw new Error("[Engine] LLVM IR çevirisi başarısız!");
    }

    // Target alt sistemlerini başlat (X86, WebAssembly, AArch64, ARM, RISCV)
    llvm.LLVMInitializeX86TargetInfo();
    llvm.LLVMInitializeX86Target();
    llvm.LLVMInitializeX86TargetMC();
    llvm.LLVMInitializeX86AsmPrinter();

    llvm.LLVMInitializeWebAssemblyTargetInfo();
    llvm.LLVMInitializeWebAssemblyTarget();
    llvm.LLVMInitializeWebAssemblyTargetMC();
    llvm.LLVMInitializeWebAssemblyAsmPrinter();

    llvm.LLVMInitializeAArch64TargetInfo();
    llvm.LLVMInitializeAArch64Target();
    llvm.LLVMInitializeAArch64TargetMC();
    llvm.LLVMInitializeAArch64AsmPrinter();

    llvm.LLVMInitializeARMTargetInfo();
    llvm.LLVMInitializeARMTarget();
    llvm.LLVMInitializeARMTargetMC();
    llvm.LLVMInitializeARMAsmPrinter();

    const targetInfo = options.targetInfo || TargetManager.resolve({
      target: options.target,
      format: options.format,
      outputFile,
      jit: options.jit,
    });

    if (options.dumpLLVM) {
      console.log("\n=== LLVM IR ===");
      const dumpPath = outputFile ? `${outputFile}.ll` : "dump.ll";
      const dumpPathBuf = Buffer.from(dumpPath + "\0", "utf8");
      const errOut = Buffer.alloc(8);
      llvm.LLVMPrintModuleToFile(llvmMod, dumpPathBuf, errOut);
      if (existsSync(dumpPath)) {
        console.log(readFileSync(dumpPath, "utf8"));
      }
    }

    // 1. JIT ÇALIŞTIRMA MODU (Sıfır Dosya, Doğrudan Bellekte Yürütme)
    if (options.jit) {
      console.log("  -> [5/6] [JIT] MCJIT Execution Engine hazırlanıyor...");
      llvm.LLVMLinkInMCJIT();

      const eeOut = Buffer.alloc(8);
      const errOut = Buffer.alloc(8);
      // MCJIT motorunu doğrudan bellek modülü üzerine kur
      const jitStatus = llvm.LLVMCreateMCJITCompilerForModule(eeOut, llvmMod, null, 0n, errOut);
      if (jitStatus !== 0) {
        throw new Error("[Engine] MCJIT oluşturulamadı!");
      }

      const ee = eeOut.readBigUInt64LE(0);
      console.log("  -> [6/6] [JIT] @main fonksiyonu bellekten çalıştırılıyor...\n");

      const fnNameBuf = Buffer.from("main\0", "utf8");
      const fnOut = Buffer.alloc(8);
      const findStatus = llvm.LLVMFindFunction(ee, fnNameBuf, fnOut);
      if (findStatus !== 0) {
        llvm.LLVMDisposeExecutionEngine(ee);
        throw new Error("[Engine] JIT: @main fonksiyonu bulunamadı!");
      }

      const fnVal = fnOut.readBigUInt64LE(0);

      try {
        // Doğrudan bellek üzerinden @main() çalıştır
        const retGeneric = llvm.LLVMRunFunction(ee, fnVal, 0, null);
        const exitCode = llvm.LLVMGenericValueToInt(retGeneric, 1);
        llvm.LLVMDisposeGenericValue(retGeneric);
        console.log(`\n[JIT] Çalışma başarıyla tamamlandı (Exit Code: ${exitCode})`);
      } finally {
        llvm.LLVMDisposeExecutionEngine(ee);
        llvm.LLVMContextDispose(llvmCtx);
        mlir.mlirPassManagerDestroy(pm);
        mlir.mlirModuleDestroy(mod);
        mlir.mlirContextDestroy(ctx);
      }
      return;
    }

    // 2. AOT DERLEME MODU (Doğrudan RAM'den Nesne Dosyasına)
    console.log(`  -> [5/6] [AOT] LLVM TargetMachine ile doğrudan nesne dosyası üretiliyor (Hedef: ${targetInfo.triple}, Format: ${targetInfo.format})...`);
    const tripleBuf = Buffer.from(targetInfo.tripleWithNull, "utf8");
    const targetOut = Buffer.alloc(8);
    const errOut = Buffer.alloc(8);

    const getTargetStatus = llvm.LLVMGetTargetFromTriple(tripleBuf, targetOut, errOut);
    if (getTargetStatus !== 0) {
      throw new Error(
        `[Engine] LLVM kütüphaneniz bu hedef mimariyi desteklemiyor (${targetInfo.triple}). ` +
        `LLVM kurulurken hedef mimari etkinleştirilmemiş olabilir.`
      );
    }
    const target = targetOut.readBigUInt64LE(0);

    const emptyBuf = Buffer.from("\0", "utf8");
    const cpuBuf = Buffer.from("generic\0", "utf8");
    const tm = llvm.LLVMCreateTargetMachine(
      target,
      tripleBuf,
      cpuBuf,
      emptyBuf,
      2, // LLVMCodeGenLevelDefault
      targetInfo.relocMode,
      0  // LLVMCodeModelDefault
    );

    // Tipik derleyici davranışı: .o/.obj dosyası çıktı adına göre belirlenir ve kalıcıdır
    const outExt = path.extname(outputFile);
    const objExt = targetInfo.isWindows && targetInfo.linkerFlavor === "link_coff" ? ".obj" : ".o";
    const objFile = outExt && outExt !== objExt
      ? outputFile.slice(0, -outExt.length) + objExt
      : (outExt === objExt ? outputFile : `${outputFile}${objExt}`);
    const objFileBuf = Buffer.from(objFile + "\0", "utf8");

    // LLVMCodeGenFileType: 1 = LLVMObjectFile (.o / .obj)
    const emitStatus = llvm.LLVMTargetMachineEmitToFile(tm, llvmMod, objFileBuf, 1, errOut);
    if (emitStatus !== 0) {
      throw new Error(`[Engine] LLVM doğrudan ${objExt} dosyasına derleyemedi!`);
    }

    console.log(`  -> [6/6] [In-Process LLD] ${targetInfo.linkerFlavor} ile bağlanıyor (Format: ${targetInfo.format})...`);
    try {
      const linkerArgs = TargetManager.getLinkerArgs(targetInfo, objFile, outputFile, options);

      // const char** argv pointer dizisini bellekte inşa et
      const argBuffers = linkerArgs.map((arg) => Buffer.from(arg + "\0", "utf8"));
      const argvBuf = Buffer.alloc(linkerArgs.length * 8);

      for (let i = 0; i < linkerArgs.length; i++) {
        const ptr = getRawPointer(argBuffers[i]);
        argvBuf.writeBigUInt64LE(ptr, i * 8);
      }

      const linkFn = bridge[targetInfo.linkerFlavor];
      if (typeof linkFn !== "function") {
        throw new Error(`[Engine] Desteklenmeyen linker fonksiyonu: ${targetInfo.linkerFlavor}`);
      }

      const linkOk = linkFn(linkerArgs.length, argvBuf);
      if (!linkOk) {
        throw new Error(`[Engine] In-Process LLD (${targetInfo.linkerFlavor} / ${targetInfo.format}) linkleme hatası!`);
      }
      console.log(`  -> [Nesne Dosyası] ${objFile} saklandı.`);
    } finally {
      llvm.LLVMDisposeTargetMachine(tm);
      llvm.LLVMDisposeModule(llvmMod);
      llvm.LLVMContextDispose(llvmCtx);
      mlir.mlirPassManagerDestroy(pm);
      mlir.mlirModuleDestroy(mod);
      mlir.mlirContextDestroy(ctx);
    }
  }
}
