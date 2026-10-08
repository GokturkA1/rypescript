// stage1/src/engine/TargetManager.ts
import { extname, dirname } from "../std/path.ts";
import { File } from "../std/fs.ts";

export class TargetInfo {
  triple: string;
  tripleWithNull: string;
  arch: string;
  vendor: string;
  os: string;
  env: string;
  format: string;
  linkMode: string;
  isWindows: boolean;
  isLinux: boolean;
  isWasm: boolean;
  isDarwin: boolean;
  isShared: boolean;
  relocMode: number;
  dataLayout: string;
  outputExtension: string;
  linkerFlavor: string;

  constructor() {
    this.triple = "x86_64-pc-linux-gnu";
    this.tripleWithNull = "x86_64-pc-linux-gnu\0";
    this.arch = "x86_64";
    this.vendor = "pc";
    this.os = "linux";
    this.env = "gnu";
    this.format = "elf";
    this.linkMode = "dynamic";
    this.isWindows = false;
    this.isLinux = true;
    this.isWasm = false;
    this.isDarwin = false;
    this.isShared = false;
    this.relocMode = 2; // LLVMRelocPIC
    this.dataLayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
    this.outputExtension = "";
    this.linkerFlavor = "link_elf";
  }
}

export class TargetManager {
  static HOST_TRIPLE: string = "x86_64-pc-linux-gnu";

  static resolve(rawTarget: string, rawFormat: string, outputFile: string, isJIT: boolean, linkMode: string): TargetInfo {
    let info = new TargetInfo();

    let mode: string = linkMode;
    if (mode.length === 0) {
      mode = "dynamic";
    }

    if (isJIT) {
      info.format = "jit";
      info.linkerFlavor = "jit";
      info.relocMode = 0;
      info.linkMode = "dynamic";
      return info;
    }

    let format: string = rawFormat;
    let targetTriple: string = rawTarget;

    const outExt: string = extname(outputFile);
    if (format.length === 0) {
      if (outExt === ".wasm") format = "wasm";
      else if (outExt === ".exe") format = "exe";
      else if (outExt === ".dll") format = "dll";
      else if (outExt === ".so") format = "so";
      else if (outExt === ".node") format = "node";
      else if (outExt === ".dylib") format = "dylib";
      else format = "elf";
    }

    if (targetTriple.length === 0) {
      if (format === "wasm") {
        targetTriple = "wasm32-unknown-unknown";
      } else if (format === "exe" || format === "coff" || format === "dll") {
        targetTriple = "x86_64-pc-windows-msvc";
      } else if (format === "mingw") {
        targetTriple = "x86_64-pc-windows-gnu";
      } else if (format === "macho" || format === "dylib") {
        targetTriple = "x86_64-apple-darwin";
      } else {
        targetTriple = TargetManager.HOST_TRIPLE;
      }
    }

    let isWasm: boolean = format === "wasm";
    let isWindows: boolean = format === "coff" || format === "exe" || format === "dll" || format === "mingw";
    let isDarwin: boolean = format === "macho" || format === "dylib";
    let isLinux: boolean = !isWasm && !isWindows && !isDarwin;
    let isShared: boolean = format === "so" || format === "dll" || format === "dylib" || format === "node";

    let linkerFlavor: string = "link_elf";
    if (isWasm) linkerFlavor = "link_wasm";
    else if (isWindows) linkerFlavor = format === "mingw" ? "link_mingw" : "link_coff";
    else if (isDarwin) linkerFlavor = "link_macho";
    else linkerFlavor = "link_elf";

    let relocMode: number = 2; // LLVMRelocPIC
    if (isWasm || mode === "static") relocMode = 0;

    info.triple = targetTriple;
    info.tripleWithNull = targetTriple + "\0";
    info.format = format;
    info.linkMode = mode;
    info.isWindows = isWindows;
    info.isLinux = isLinux;
    info.isWasm = isWasm;
    info.isDarwin = isDarwin;
    info.isShared = isShared;
    info.relocMode = relocMode;
    info.linkerFlavor = linkerFlavor;

    return info;
  }

  static getLinkerArgs(targetInfo: TargetInfo, objFile: string, outputFile: string, nativeLibs: string[]): string[] {
    if (targetInfo.linkerFlavor === "link_elf") {
      if (targetInfo.format === "elf") {
        let crtDir: string = "/usr/lib";
        if (File.exists("/usr/lib/crt1.o") || File.exists("/usr/lib/Scrt1.o")) {
          crtDir = "/usr/lib";
        } else if (File.exists("/usr/lib/x86_64-linux-gnu/crt1.o") || File.exists("/usr/lib/x86_64-linux-gnu/Scrt1.o")) {
          crtDir = "/usr/lib/x86_64-linux-gnu";
        }

        let crt1: string = crtDir + "/Scrt1.o";
        if (targetInfo.linkMode === "static" || !File.exists(crt1)) {
          crt1 = crtDir + "/crt1.o";
        }
        let crti: string = crtDir + "/crti.o";
        let crtn: string = crtDir + "/crtn.o";

        if (targetInfo.linkMode === "static") {
          let staticArgs: string[] = [
            "-static",
            crt1,
            crti,
            objFile,
            "-L" + crtDir,
            "-lc",
            "-lm",
            "-lpthread",
            crtn,
            "-o",
            outputFile
          ];
          return staticArgs;
        }

        let defaultArgs: string[] = [
          "-pie",
          "-dynamic-linker",
          "/lib64/ld-linux-x86-64.so.2",
          crt1,
          crti,
          objFile,
          "-L" + crtDir,
          "-lc",
          "-lm",
          "-lpthread",
          crtn,
          "-o",
          outputFile
        ];
        return defaultArgs;
      }

      let sharedArgs: string[] = [
        "-shared",
        objFile,
        "-L/usr/lib/x86_64-linux-gnu",
        "-lc",
        "-lm",
        "-lpthread",
        "-o",
        outputFile
      ];
      return sharedArgs;
    }

    if (targetInfo.linkerFlavor === "link_wasm") {
      let wasmArgs: string[] = [
        objFile,
        "-o",
        outputFile,
        "--no-entry",
        "--export-all",
        "--allow-undefined"
      ];
      return wasmArgs;
    }

    if (targetInfo.linkerFlavor === "link_coff") {
      let coffArgs: string[] = [
        objFile,
        "/out:" + outputFile,
        "/entry:main",
        "/subsystem:console"
      ];
      return coffArgs;
    }

    if (targetInfo.linkerFlavor === "link_macho") {
      let machoArgs: string[] = [
        "-o",
        outputFile,
        objFile,
        "-lSystem"
      ];
      return machoArgs;
    }

    if (targetInfo.linkerFlavor === "link_mingw") {
      let mingwArgs: string[] = [
        "-m", "i386pep",
        "-o", outputFile,
        objFile,
        "--entry=main",
        "--subsystem=console",
        "-L/usr/lib/wine/x86_64-windows",
        "-lmsvcrt",
        "-lkernel32",
        "-lcompiler-rt"
      ];
      return mingwArgs;
    }

    let emptyArgs: string[] = [];
    return emptyArgs;
  }
}
