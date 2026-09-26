// src/engine/CompilerEngine.js
import { dlopen, getRawPointer, suffix } from "node:ffi";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  // Target & TargetMachine API (X86 + WebAssembly)
  LLVMInitializeX86TargetInfo: { arguments: [], return: "void" },
  LLVMInitializeX86Target: { arguments: [], return: "void" },
  LLVMInitializeX86TargetMC: { arguments: [], return: "void" },
  LLVMInitializeX86AsmPrinter: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyTargetInfo: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyTarget: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyTargetMC: { arguments: [], return: "void" },
  LLVMInitializeWebAssemblyAsmPrinter: { arguments: [], return: "void" },
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

    const format = options.format || "elf";

    // Target alt sistemlerini başlat
    llvm.LLVMInitializeX86TargetInfo();
    llvm.LLVMInitializeX86Target();
    llvm.LLVMInitializeX86TargetMC();
    llvm.LLVMInitializeX86AsmPrinter();
    llvm.LLVMInitializeWebAssemblyTargetInfo();
    llvm.LLVMInitializeWebAssemblyTarget();
    llvm.LLVMInitializeWebAssemblyTargetMC();
    llvm.LLVMInitializeWebAssemblyAsmPrinter();

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

    // 2. AOT DERLEME MODU (Doğrudan RAM'den .o Nesne Dosyasına)
    console.log(`  -> [5/6] [AOT] LLVM TargetMachine ile doğrudan .o dosyası üretiliyor (${format})...`);
    const tripleStr = format === "wasm" ? "wasm32-unknown-unknown\0" : "x86_64-pc-linux-gnu\0";
    const tripleBuf = Buffer.from(tripleStr, "utf8");
    const targetOut = Buffer.alloc(8);
    const errOut = Buffer.alloc(8);

    const getTargetStatus = llvm.LLVMGetTargetFromTriple(tripleBuf, targetOut, errOut);
    if (getTargetStatus !== 0) {
      throw new Error(
        `[Engine] LLVM kütüphaneniz bu hedef mimariyi desteklemiyor (${tripleStr.trim()}). ` +
        `LLVM kurulurken hedef mimari olarak yalnızca X86 etkinleştirilmiş olabilir.`
      );
    }
    const target = targetOut.readBigUInt64LE(0);

    const emptyBuf = Buffer.from("\0", "utf8");
    const cpuBuf = Buffer.from("generic\0", "utf8");
    // RelocMode: 2 (LLVMRelocPIC) - Paylaşımlı kütüphaneler (.so, .node) ve PIE için zorunludur
    const relocMode = (format === "elf" || format === "so" || format === "node") ? 2 : 0;
    const tm = llvm.LLVMCreateTargetMachine(target, tripleBuf, cpuBuf, emptyBuf, 2, relocMode, 0);

    // Tipik derleyici davranışı: .o dosyası çıktı adına göre belirlenir ve kalıcıdır
    const outExt = path.extname(outputFile);
    const objFile = outExt && outExt !== ".o"
      ? outputFile.slice(0, -outExt.length) + ".o"
      : (outExt === ".o" ? outputFile : `${outputFile}.o`);
    const objFileBuf = Buffer.from(objFile + "\0", "utf8");

    // LLVMCodeGenFileType: 1 = LLVMObjectFile (.o)
    const emitStatus = llvm.LLVMTargetMachineEmitToFile(tm, llvmMod, objFileBuf, 1, errOut);
    if (emitStatus !== 0) {
      throw new Error("[Engine] LLVM doğrudan .o dosyasına derleyemedi!");
    }

    console.log(`  -> [6/6] [In-Process LLD] libbridge.so ile bağlanıyor (Format: ${format})...`);
    try {
      let linkerArgs = [];

      if (format === "elf") {
        const crtDirs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu"];
        const crtDir = crtDirs.find((d) => existsSync(`${d}/crt1.o`) || existsSync(`${d}/Scrt1.o`)) || "/usr/lib";
        const crt1 = existsSync(`${crtDir}/Scrt1.o`) ? `${crtDir}/Scrt1.o` : `${crtDir}/crt1.o`;
        const crti = `${crtDir}/crti.o`;
        const crtn = `${crtDir}/crtn.o`;

        const nativeArgs = [];
        if (options.nativeLibs && options.nativeLibs.length > 0) {
          for (const libPath of options.nativeLibs) {
            const libDir = path.dirname(libPath);
            nativeArgs.push(`-L${libDir}`);
            nativeArgs.push(`-rpath=${libDir}`);
            nativeArgs.push(libPath);
          }
        }

        linkerArgs = [
          "-pie",
          "-dynamic-linker", "/lib64/ld-linux-x86-64.so.2",
          crt1,
          crti,
          objFile,
          ...nativeArgs,
          `-L${crtDir}`,
          "-lc",
          "-lm",
          "-lpthread",
          crtn,
          "-o", outputFile,
        ];
      } else if (format === "so" || format === "node") {
        const searchDirs = [
          "/usr/lib",
          "/usr/lib64",
          "/usr/lib/x86_64-linux-gnu",
          "/lib/x86_64-linux-gnu",
          "/lib64",
          "/lib",
        ].filter((d) => existsSync(d));

        linkerArgs = [
          "-shared",
          objFile,
          ...searchDirs.map((d) => `-L${d}`),
          "-lc",
          "-lm",
          "-lpthread",
          "-o", outputFile,
        ];
      } else if (format === "coff") {
        linkerArgs = [objFile, `/out:${outputFile}`, "/entry:main", "/subsystem:console"];
      } else if (format === "macho") {
        linkerArgs = ["-o", outputFile, objFile, "-lSystem"];
      } else if (format === "wasm") {
        linkerArgs = [
          objFile,
          "-o", outputFile,
          "--no-entry",
          "--export-all",
          "--allow-undefined"
        ];
      } else if (format === "mingw") {
        linkerArgs = ["-o", outputFile, objFile, "-lkernel32", "-lmsvcrt"];
      } else {
        throw new Error(`[Engine] Desteklenmeyen format: ${format}`);
      }

      // const char** argv pointer dizisini bellekte inşa et
      const argBuffers = linkerArgs.map((arg) => Buffer.from(arg + "\0", "utf8"));
      const argvBuf = Buffer.alloc(linkerArgs.length * 8);

      for (let i = 0; i < linkerArgs.length; i++) {
        const ptr = getRawPointer(argBuffers[i]);
        argvBuf.writeBigUInt64LE(ptr, i * 8);
      }

      let linkOk = false;
      if (format === "elf" || format === "so" || format === "node") linkOk = bridge.link_elf(linkerArgs.length, argvBuf);
      else if (format === "coff") linkOk = bridge.link_coff(linkerArgs.length, argvBuf);
      else if (format === "macho") linkOk = bridge.link_macho(linkerArgs.length, argvBuf);
      else if (format === "wasm") linkOk = bridge.link_wasm(linkerArgs.length, argvBuf);
      else if (format === "mingw") linkOk = bridge.link_mingw(linkerArgs.length, argvBuf);

      if (!linkOk) {
        throw new Error(`[Engine] In-Process LLD (${format}) linkleme hatası!`);
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
