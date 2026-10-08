// stage1/src/engine/CompilerEngine.ts
import { TargetInfo, TargetManager } from "./TargetManager.ts";
import { File } from "../std/fs.ts";
import { println, print, eprintln } from "../std/io.ts";

export declare function mlirRegisterAllPasses(): void;
export declare function mlirContextCreate(): pointer;
export declare function mlirDialectRegistryCreate(): pointer;
export declare function mlirRegisterAllDialects(registry: pointer): void;
export declare function mlirContextAppendDialectRegistry(context: pointer, registry: pointer): void;
export declare function mlirDialectRegistryDestroy(registry: pointer): void;
export declare function mlirContextLoadAllAvailableDialects(context: pointer): void;
export declare function mlirRegisterAllLLVMTranslations(context: pointer): void;
export declare function mlirContextDestroy(context: pointer): void;
export declare function mlirModuleCreateParse(context: pointer, stringData: pointer, stringLen: i64): pointer;
export declare function mlirModuleGetOperation(module: pointer): pointer;
export declare function mlirOperationVerify(op: pointer): boolean;
export declare function mlirModuleDestroy(module: pointer): void;
export declare function mlirPassManagerCreate(context: pointer): pointer;
export declare function mlirPassManagerGetAsOpPassManager(pm: pointer): pointer;
export declare function mlirPassManagerDestroy(pm: pointer): void;
export declare function mlirPassManagerRunOnOp(pm: pointer, op: pointer): i32;
export declare function mlirOpPassManagerAddPipeline(pm: pointer, pipelineStr: pointer, pipelineLen: i64, errFn: pointer, userData: pointer): i32;
export declare function mlirTranslateModuleToLLVMIR(op: pointer, llvmContext: pointer): pointer;

export declare function LLVMContextCreate(): pointer;
export declare function LLVMContextDispose(ctx: pointer): void;
export declare function LLVMPrintModuleToFile(module: pointer, filename: pointer, errorMessage: pointer): i32;
export declare function LLVMDisposeModule(module: pointer): void;
export declare function LLVMInitializeX86TargetInfo(): void;
export declare function LLVMInitializeX86Target(): void;
export declare function LLVMInitializeX86TargetMC(): void;
export declare function LLVMInitializeX86AsmPrinter(): void;
export declare function LLVMInitializeWebAssemblyTargetInfo(): void;
export declare function LLVMInitializeWebAssemblyTarget(): void;
export declare function LLVMInitializeWebAssemblyTargetMC(): void;
export declare function LLVMInitializeWebAssemblyAsmPrinter(): void;
export declare function LLVMInitializeAArch64TargetInfo(): void;
export declare function LLVMInitializeAArch64Target(): void;
export declare function LLVMInitializeAArch64TargetMC(): void;
export declare function LLVMInitializeAArch64AsmPrinter(): void;
export declare function LLVMInitializeARMTargetInfo(): void;
export declare function LLVMInitializeARMTarget(): void;
export declare function LLVMInitializeARMTargetMC(): void;
export declare function LLVMInitializeARMAsmPrinter(): void;
export declare function LLVMGetTargetFromTriple(triple: pointer, targetOut: pointer, errorMessage: pointer): i32;
export declare function LLVMCreateTargetMachine(target: pointer, triple: pointer, cpu: pointer, features: pointer, level: i32, reloc: i32, codeModel: i32): pointer;
export declare function LLVMDisposeTargetMachine(tm: pointer): void;
export declare function LLVMTargetMachineEmitToFile(tm: pointer, module: pointer, filename: pointer, codegen: i32, errorMessage: pointer): i32;

export declare function link_elf(argc: i32, argv: pointer): boolean;
export declare function link_coff(argc: i32, argv: pointer): boolean;
export declare function link_macho(argc: i32, argv: pointer): boolean;
export declare function link_wasm(argc: i32, argv: pointer): boolean;
export declare function link_mingw(argc: i32, argv: pointer): boolean;

function write_ptr(dest: pointer, i32_idx: number, ptr: pointer): void {
  let addr: i64 = ptr as i64;
  let low: i32 = addr as i32;
  let high: i32 = (addr >> 32) as i32;
  ptr_write_i32(dest, i32_idx, low);
  ptr_write_i32(dest, i32_idx + 1, high);
}

function read_ptr(src: pointer, i32_idx: number): pointer {
  let low: i64 = (ptr_read_i32(src, i32_idx) as i64) & 0xFFFFFFFF;
  let high: i64 = ptr_read_i32(src, i32_idx + 1) as i64;
  let addr: i64 = low | (high << 32);
  return addr as pointer;
}

function containsSubstr(str: string, substr: string): boolean {
  let sLen: number = str.length;
  let subLen: number = substr.length;
  if (subLen === 0) return true;
  if (sLen < subLen) return false;
  for (let i: number = 0; i <= sLen - subLen; i++) {
    let match: boolean = true;
    for (let j: number = 0; j < subLen; j++) {
      if (str.charCodeAt(i + j) !== substr.charCodeAt(j)) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

export class CompilerEngine {
  static compile(mlirSource: string, outputFile: string, targetInfo: TargetInfo, nativeLibs: string[]): boolean {
    println("  -> [1/6] MLIR ve LLVM motoru başlatılıyor...");
    mlirRegisterAllPasses();

    let ctx: pointer = mlirContextCreate();
    let reg: pointer = mlirDialectRegistryCreate();
    mlirRegisterAllDialects(reg);
    mlirContextAppendDialectRegistry(ctx, reg);
    mlirDialectRegistryDestroy(reg);
    mlirContextLoadAllAvailableDialects(ctx);
    mlirRegisterAllLLVMTranslations(ctx);

    println("  -> [2/6] MLIR modülü ayrıştırılıyor...");
    let mod: pointer = mlirModuleCreateParse(ctx, mlirSource as pointer, mlirSource.length as i64);
    if (mod === null) {
      mlirContextDestroy(ctx);
      eprintln("[Engine] MLIR ayrıştırma hatası! Sözdizimi geçersiz.");
      return false;
    }

    println("  -> [3/6] PassManager lowering pipeline yürütülüyor...");
    let pm: pointer = mlirPassManagerCreate(ctx);
    let opPm: pointer = mlirPassManagerGetAsOpPassManager(pm);

    let pipeline: string = "convert-vector-to-llvm,convert-math-to-llvm,convert-scf-to-cf,convert-cf-to-llvm,convert-arith-to-llvm,convert-func-to-llvm,reconcile-unrealized-casts";
    let pipeRes: i32 = mlirOpPassManagerAddPipeline(opPm, pipeline as pointer, pipeline.length as i64, null, null);
    if (pipeRes === 0) {
      mlirPassManagerDestroy(pm);
      mlirModuleDestroy(mod);
      mlirContextDestroy(ctx);
      eprintln("[Engine] Pass pipeline oluşturulamadı!");
      return false;
    }

    let op: pointer = mlirModuleGetOperation(mod);
    let runStatus: i32 = mlirPassManagerRunOnOp(pm, op);
    if (runStatus === 0) {
      mlirPassManagerDestroy(pm);
      mlirModuleDestroy(mod);
      mlirContextDestroy(ctx);
      eprintln("[Engine] MLIR lowering pass'leri başarısız oldu!");
      return false;
    }

    println("  -> [4/6] MLIR'dan LLVM IR modülüne çevriliyor...");
    let llvmCtx: pointer = LLVMContextCreate();
    let llvmMod: pointer = mlirTranslateModuleToLLVMIR(op, llvmCtx);
    if (llvmMod === null) {
      mlirPassManagerDestroy(pm);
      mlirModuleDestroy(mod);
      mlirContextDestroy(ctx);
      LLVMContextDispose(llvmCtx);
      eprintln("[Engine] LLVM IR çevirisi başarısız!");
      return false;
    }

    LLVMInitializeX86TargetInfo();
    LLVMInitializeX86Target();
    LLVMInitializeX86TargetMC();
    LLVMInitializeX86AsmPrinter();

    LLVMInitializeWebAssemblyTargetInfo();
    LLVMInitializeWebAssemblyTarget();
    LLVMInitializeWebAssemblyTargetMC();
    LLVMInitializeWebAssemblyAsmPrinter();

    LLVMInitializeAArch64TargetInfo();
    LLVMInitializeAArch64Target();
    LLVMInitializeAArch64TargetMC();
    LLVMInitializeAArch64AsmPrinter();

    LLVMInitializeARMTargetInfo();
    LLVMInitializeARMTarget();
    LLVMInitializeARMTargetMC();
    LLVMInitializeARMAsmPrinter();

    println("  -> [5/6] [AOT] LLVM TargetMachine ile doğrudan nesne dosyası üretiliyor (Hedef: " + targetInfo.triple + ", Format: " + targetInfo.format + ")...");
    let targetMem: pointer = malloc(8);
    let errMem: pointer = malloc(8);

    let tripleStr: string = targetInfo.triple;
    let getTargetStatus: i32 = LLVMGetTargetFromTriple(tripleStr as pointer, targetMem, errMem);
    if (getTargetStatus !== 0) {
      eprintln("[Engine] LLVM hedef mimariyi desteklemiyor (" + targetInfo.triple + ")");
      free(targetMem);
      free(errMem);
      return false;
    }

    let target: pointer = read_ptr(targetMem, 0);
    free(targetMem);
    free(errMem);

    let emptyStr: string = "";
    let cpuStr: string = "generic";
    let tm: pointer = LLVMCreateTargetMachine(
      target,
      tripleStr as pointer,
      cpuStr as pointer,
      emptyStr as pointer,
      2, // LLVMCodeGenLevelDefault
      targetInfo.relocMode,
      0  // LLVMCodeModelDefault
    );

    let objExt: string = targetInfo.isWindows && targetInfo.linkerFlavor === "link_coff" ? ".obj" : ".o";
    let objFile: string = outputFile + objExt;


    let errOut: pointer = malloc(8);

    // LLVMCodeGenFileType: 1 = LLVMObjectFile (.o / .obj)
    let emitStatus: i32 = LLVMTargetMachineEmitToFile(tm, llvmMod, objFile as pointer, 1, errOut);
    free(errOut);
    if (emitStatus !== 0) {
      eprintln("[Engine] LLVM doğrudan nesne dosyasına derleyemedi!");
      return false;
    }

    println("  -> [6/6] [In-Process LLD] " + targetInfo.linkerFlavor + " ile bağlanıyor (Format: " + targetInfo.format + ")...");
    let linkOk: boolean = false;

    if (targetInfo.linkerFlavor === "link_elf") {
      if (targetInfo.format === "elf") {
        let isBuildingRypec: boolean = containsSubstr(outputFile, "rypec");
        let linkMode: string = targetInfo.linkMode;
        let crtDir: string = "/usr/lib";
        if (File.exists("/usr/lib/crt1.o") || File.exists("/usr/lib/Scrt1.o")) {
          crtDir = "/usr/lib";
        } else if (File.exists("/usr/lib/x86_64-linux-gnu/crt1.o") || File.exists("/usr/lib/x86_64-linux-gnu/Scrt1.o")) {
          crtDir = "/usr/lib/x86_64-linux-gnu";
        }

        let gccDir: string = "/usr/lib/gcc/x86_64-pc-linux-gnu/16";
        if (!File.exists(gccDir + "/crtbeginS.o") && !File.exists(gccDir + "/crtbeginT.o")) {
          if (File.exists("/usr/lib/gcc/x86_64-linux-gnu/13/crtbeginS.o")) {
            gccDir = "/usr/lib/gcc/x86_64-linux-gnu/13";
          } else if (File.exists("/usr/lib/gcc/x86_64-pc-linux-gnu/14/crtbeginS.o")) {
            gccDir = "/usr/lib/gcc/x86_64-pc-linux-gnu/14";
          }
        }

        let crt1: string = crtDir + "/crt1.o";
        let crtbegin: string = gccDir + "/crtbeginT.o";
        let crtend: string = gccDir + "/crtend.o";

        if (linkMode !== "static") {
          crt1 = crtDir + "/Scrt1.o";
          if (!File.exists(crt1)) {
            crt1 = crtDir + "/crt1.o";
          }
          crtbegin = gccDir + "/crtbeginS.o";
          crtend = gccDir + "/crtendS.o";
        }

        let crti: string = crtDir + "/crti.o";
        let crtn: string = crtDir + "/crtn.o";

        let argvMem: pointer = malloc(48 * 8);
        let argIdx: number = 0;

        if (linkMode === "static") {
          write_ptr(argvMem, argIdx * 2, "-static" as pointer); argIdx = argIdx + 1;
        } else {
          write_ptr(argvMem, argIdx * 2, "-pie" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-dynamic-linker" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "/lib64/ld-linux-x86-64.so.2" as pointer); argIdx = argIdx + 1;
        }

        write_ptr(argvMem, argIdx * 2, crt1 as pointer); argIdx = argIdx + 1;
        write_ptr(argvMem, argIdx * 2, crti as pointer); argIdx = argIdx + 1;
        if (File.exists(crtbegin)) {
          write_ptr(argvMem, argIdx * 2, crtbegin as pointer); argIdx = argIdx + 1;
        }
        write_ptr(argvMem, argIdx * 2, objFile as pointer); argIdx = argIdx + 1;

        if (isBuildingRypec) {
          if (linkMode === "dynamic") {
            if (File.exists("bin/liboxc_parser.so")) {
              write_ptr(argvMem, argIdx * 2, "bin/liboxc_parser.so" as pointer); argIdx = argIdx + 1;
            } else if (File.exists("bin/liboxc_parser.a")) {
              write_ptr(argvMem, argIdx * 2, "bin/liboxc_parser.a" as pointer); argIdx = argIdx + 1;
            }
          } else {
            // standalone or static: prefer .a
            if (File.exists("bin/liboxc_parser.a")) {
              write_ptr(argvMem, argIdx * 2, "bin/liboxc_parser.a" as pointer); argIdx = argIdx + 1;
            } else if (File.exists("bin/liboxc_parser.so")) {
              write_ptr(argvMem, argIdx * 2, "bin/liboxc_parser.so" as pointer); argIdx = argIdx + 1;
            }
          }
          if (File.exists("bridge.o")) {
            write_ptr(argvMem, argIdx * 2, "bridge.o" as pointer); argIdx = argIdx + 1;
          }
          if (File.exists("bin/llvm_libs.rsp")) {
            write_ptr(argvMem, argIdx * 2, "@bin/llvm_libs.rsp" as pointer); argIdx = argIdx + 1;
          }
        }

        let lCrt: string = "-L" + crtDir;
        write_ptr(argvMem, argIdx * 2, lCrt as pointer); argIdx = argIdx + 1;
        if (File.exists(gccDir)) {
          let lGcc: string = "-L" + gccDir;
          write_ptr(argvMem, argIdx * 2, lGcc as pointer); argIdx = argIdx + 1;
        }
        if (isBuildingRypec) {
          write_ptr(argvMem, argIdx * 2, "-Lbin" as pointer); argIdx = argIdx + 1;
          if (linkMode !== "static") {
            write_ptr(argvMem, argIdx * 2, "-rpath=bin" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-rpath=$ORIGIN" as pointer); argIdx = argIdx + 1;
          }
        }

        if (linkMode === "static") {
          write_ptr(argvMem, argIdx * 2, "--start-group" as pointer); argIdx = argIdx + 1;
          if (isBuildingRypec) {
            write_ptr(argvMem, argIdx * 2, "-lstdc++" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lgcc" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lgcc_eh" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lz" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lzstd" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lxml2" as pointer); argIdx = argIdx + 1;
          }
          write_ptr(argvMem, argIdx * 2, "-lc" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lm" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lpthread" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-ldl" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lgcc" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lgcc_eh" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "--end-group" as pointer); argIdx = argIdx + 1;
        } else if (linkMode === "standalone") {
          write_ptr(argvMem, argIdx * 2, "-Bstatic" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lstdc++" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lgcc" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lgcc_eh" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-Bdynamic" as pointer); argIdx = argIdx + 1;
          if (isBuildingRypec) {
            write_ptr(argvMem, argIdx * 2, "-lz" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lzstd" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lxml2" as pointer); argIdx = argIdx + 1;
          }
          write_ptr(argvMem, argIdx * 2, "-lpthread" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-ldl" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lm" as pointer); argIdx = argIdx + 1;
          write_ptr(argvMem, argIdx * 2, "-lc" as pointer); argIdx = argIdx + 1;
        } else {
          if (isBuildingRypec) {
            write_ptr(argvMem, argIdx * 2, "-lstdc++" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lgcc" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lgcc_s" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lz" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lzstd" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lxml2" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lpthread" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-ldl" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lm" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lc" as pointer); argIdx = argIdx + 1;
          } else {
            write_ptr(argvMem, argIdx * 2, "-lc" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lm" as pointer); argIdx = argIdx + 1;
            write_ptr(argvMem, argIdx * 2, "-lpthread" as pointer); argIdx = argIdx + 1;
          }
        }

        if (File.exists(crtend)) {
          write_ptr(argvMem, argIdx * 2, crtend as pointer); argIdx = argIdx + 1;
        }
        write_ptr(argvMem, argIdx * 2, crtn as pointer); argIdx = argIdx + 1;
        write_ptr(argvMem, argIdx * 2, "-o" as pointer); argIdx = argIdx + 1;
        write_ptr(argvMem, argIdx * 2, outputFile as pointer); argIdx = argIdx + 1;

        linkOk = link_elf(argIdx, argvMem);
        free(argvMem);
      } else {
        let argvMem: pointer = malloc(8 * 8);
        write_ptr(argvMem, 0, "-shared" as pointer);
        write_ptr(argvMem, 2, objFile as pointer);
        write_ptr(argvMem, 4, "-L/usr/lib" as pointer);
        write_ptr(argvMem, 6, "-lc" as pointer);
        write_ptr(argvMem, 8, "-lm" as pointer);
        write_ptr(argvMem, 10, "-lpthread" as pointer);
        write_ptr(argvMem, 12, "-o" as pointer);
        write_ptr(argvMem, 14, outputFile as pointer);

        linkOk = link_elf(8, argvMem);
        free(argvMem);
      }
    } else if (targetInfo.linkerFlavor === "link_wasm") {
      let argvMem: pointer = malloc(6 * 8);
      write_ptr(argvMem, 0, objFile as pointer);
      write_ptr(argvMem, 2, "-o" as pointer);
      write_ptr(argvMem, 4, outputFile as pointer);
      write_ptr(argvMem, 6, "--no-entry" as pointer);
      write_ptr(argvMem, 8, "--export-all" as pointer);
      write_ptr(argvMem, 10, "--allow-undefined" as pointer);

      linkOk = link_wasm(6, argvMem);
      free(argvMem);
    } else if (targetInfo.linkerFlavor === "link_coff") {
      let outArg: string = "/out:" + outputFile;
      let argvMem: pointer = malloc(4 * 8);
      write_ptr(argvMem, 0, objFile as pointer);
      write_ptr(argvMem, 2, outArg as pointer);
      write_ptr(argvMem, 4, "/entry:main" as pointer);
      write_ptr(argvMem, 6, "/subsystem:console" as pointer);

      linkOk = link_coff(4, argvMem);
      free(argvMem);
    } else if (targetInfo.linkerFlavor === "link_macho") {
      let argvMem: pointer = malloc(4 * 8);
      write_ptr(argvMem, 0, "-o" as pointer);
      write_ptr(argvMem, 2, outputFile as pointer);
      write_ptr(argvMem, 4, objFile as pointer);
      write_ptr(argvMem, 6, "-lSystem" as pointer);

      linkOk = link_macho(4, argvMem);
      free(argvMem);
    } else if (targetInfo.linkerFlavor === "link_mingw") {
      let argvMem: pointer = malloc(5 * 8);
      write_ptr(argvMem, 0, "-o" as pointer);
      write_ptr(argvMem, 2, outputFile as pointer);
      write_ptr(argvMem, 4, objFile as pointer);
      write_ptr(argvMem, 6, "-lkernel32" as pointer);
      write_ptr(argvMem, 8, "-lmsvcrt" as pointer);

      linkOk = link_mingw(5, argvMem);
      free(argvMem);
    }
    LLVMDisposeTargetMachine(tm);
    LLVMDisposeModule(llvmMod);
    LLVMContextDispose(llvmCtx);
    mlirPassManagerDestroy(pm);
    mlirModuleDestroy(mod);
    mlirContextDestroy(ctx);

    if (!linkOk) {
      eprintln("[Engine] In-Process LLD (" + targetInfo.linkerFlavor + ") linkleme hatası!");
      return false;
    }

    println("  -> [Nesne Dosyası] " + objFile + " saklandı.");
    return true;
  }
}
