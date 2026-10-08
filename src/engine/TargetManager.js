// src/engine/TargetManager.js
import fs, { existsSync } from "node:fs";
import path from "node:path";

/**
 * Cross-Compile ve Target Triplet Motoru.
 * Farklı mimari (X86, Wasm, ARM, AArch64) ve işletim sistemi (Linux, Windows, macOS, Wasm)
 * hedeflerini ayrıştırır, LLVM TargetMachine, Data Layout, Relocation Mode ve LLD
 * bağlayıcı parametrelerini belirler.
 */
export class TargetManager {
  static HOST_TRIPLE = "x86_64-pc-linux-gnu";

  /**
   * Triplet dizesini bileşenlerine ayırır.
   * @param {string} tripleStr 
   */
  static parseTriple(tripleStr) {
    if (!tripleStr || typeof tripleStr !== "string") {
      tripleStr = this.HOST_TRIPLE;
    }

    const parts = tripleStr.toLowerCase().split("-");
    const rawArch = parts[0] || "x86_64";
    let arch = rawArch;
    if (rawArch === "amd64") arch = "x86_64";
    if (rawArch === "arm64") arch = "aarch64";

    let vendor = "unknown";
    let os = "linux";
    let env = "gnu";

    if (arch.startsWith("wasm")) {
      vendor = "unknown";
      os = "wasm";
      env = parts[2] === "wasi" ? "wasi" : "unknown";
    } else if (parts.length === 2) {
      // örn: x86_64-linux, aarch64-darwin
      os = parts[1];
    } else if (parts.length === 3) {
      // örn: x86_64-pc-windows, x86_64-apple-darwin
      vendor = parts[1];
      os = parts[2];
    } else if (parts.length >= 4) {
      // örn: x86_64-pc-windows-msvc, x86_64-unknown-linux-gnu
      vendor = parts[1];
      os = parts[2];
      env = parts[3];
    }

    // OS Normalizasyonu
    if (os.includes("win")) os = "windows";
    else if (os.includes("darwin") || os.includes("macos") || os.includes("apple") || os.includes("osx")) os = "darwin";
    else if (os.includes("linux")) os = "linux";
    else if (arch.startsWith("wasm")) os = "wasm";

    // Env Normalizasyonu
    if (os === "windows") {
      if (!env || env === "unknown") env = "msvc";
    } else if (os === "linux") {
      if (!env || env === "unknown") env = "gnu";
    }

    return { arch, vendor, os, env };
  }

  /**
   * CLI ve derleyici seçeneklerine göre nihai TargetInfo nesnesini çözer.
   * @param {object} options 
   */
  static resolve(options = {}) {
    const rawTarget = options.target || null;
    const rawFormat = (options.format || "").toLowerCase().trim() || null;
    const outputFile = options.outputFile || "";
    const isJIT = Boolean(options.jit);
    const linkMode = options.linkMode || "dynamic";

    if (isJIT) {
      return {
        triple: this.HOST_TRIPLE,
        tripleWithNull: this.HOST_TRIPLE + "\0",
        arch: "x86_64",
        os: "linux",
        env: "gnu",
        format: "jit",
        linkMode: "dynamic",
        isWindows: false,
        isLinux: true,
        isWasm: false,
        isDarwin: false,
        isShared: false,
        relocMode: 0,
        dataLayout: "",
        outputExtension: "",
        linkerFlavor: "jit",
      };
    }

    let targetTriple = rawTarget;
    let format = rawFormat;

    // 1. Çıktı dosya uzantısından format çıkarımı (Eğer format belirtilmediyse)
    const outExt = path.extname(outputFile).toLowerCase();
    if (!format) {
      if (outExt === ".wasm") format = "wasm";
      else if (outExt === ".exe") format = "exe";
      else if (outExt === ".dll") format = "dll";
      else if (outExt === ".so") format = "so";
      else if (outExt === ".node") format = "node";
      else if (outExt === ".dylib") format = "dylib";
    }

    // 2. Format üzerinden hedef mimari çıkarımı (Eğer doğrudan --target verilmediyse)
    if (!targetTriple && format) {
      switch (format) {
        case "wasm":
          targetTriple = "wasm32-unknown-unknown";
          break;
        case "exe":
        case "coff":
          targetTriple = "x86_64-pc-windows-msvc";
          break;
        case "dll":
          targetTriple = "x86_64-pc-windows-msvc";
          break;
        case "mingw":
          targetTriple = "x86_64-pc-windows-gnu";
          break;
        case "macho":
        case "dylib":
          targetTriple = "x86_64-apple-darwin";
          break;
        case "so":
        case "node":
        case "elf":
        default:
          targetTriple = this.HOST_TRIPLE;
          break;
      }
    }

    // 3. Varsayılan Triplet belirleme
    if (!targetTriple) {
      targetTriple = this.HOST_TRIPLE;
    }

    const { arch, vendor, os, env } = this.parseTriple(targetTriple);

    // 4. Nihai formatı ve dosya uzantısını belirle
    const isWindows = os === "windows";
    const isWasm = arch.startsWith("wasm") || os === "wasm";
    const isDarwin = os === "darwin";
    const isLinux = os === "linux";

    if (!format) {
      if (isWasm) format = "wasm";
      else if (isWindows) format = outExt === ".dll" ? "dll" : "exe";
      else if (isDarwin) format = outExt === ".dylib" ? "dylib" : "macho";
      else format = outExt === ".so" ? "so" : (outExt === ".node" ? "node" : "elf");
    }

    const isShared = format === "so" || format === "node" || format === "napi" || format === "dll" || format === "dylib";

    // 5. LLVM Relocation Mode (0: Default/Static, 2: PIC)
    // Paylaşımlı kütüphaneler (.so, .node, .dll, .dylib) ve Linux PIE için RelocMode: 2 zorunludur
    let relocMode = 0;
    if (isShared || (format === "elf" && linkMode !== "static")) {
      relocMode = 2; // LLVMRelocPIC
    }

    // 6. Standart LLVM Data Layout (Opsiyonel / LLVM otomatik tamamlayabilir)
    let dataLayout = "";
    if (arch === "x86_64") {
      if (isWindows) {
        dataLayout = "e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
      } else if (isDarwin) {
        dataLayout = "e-m:o-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
      } else {
        dataLayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128";
      }
    } else if (arch === "wasm32") {
      dataLayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20";
    } else if (arch === "aarch64") {
      dataLayout = isDarwin
        ? "e-m:o-i64:64-i128:128-n32:64-S128"
        : "e-m:e-i8:8:32-i16:16:32-i64:64-i128:128-n32:64-S128";
    }

    // 7. LLD Linker Flavor
    let linkerFlavor = "link_elf";
    if (isWasm) {
      linkerFlavor = "link_wasm";
    } else if (isWindows) {
      linkerFlavor = (env === "gnu" || format === "mingw") ? "link_mingw" : "link_coff";
    } else if (isDarwin) {
      linkerFlavor = "link_macho";
    } else {
      linkerFlavor = "link_elf";
    }

    // 8. Önerilen Çıktı Uzantısı
    let outputExtension = "";
    if (format === "wasm") outputExtension = ".wasm";
    else if (format === "exe" || format === "coff") outputExtension = ".exe";
    else if (format === "dll") outputExtension = ".dll";
    else if (format === "so") outputExtension = ".so";
    else if (format === "node") outputExtension = ".node";
    else if (format === "dylib") outputExtension = ".dylib";

    // Tam normalize edilmiş triple string
    const normalizedTriple = isWasm
      ? "wasm32-unknown-unknown"
      : `${arch}-${vendor}-${os === "windows" ? "windows" : os}${env ? `-${env}` : ""}`;

    return {
      triple: normalizedTriple,
      tripleWithNull: normalizedTriple + "\0",
      arch,
      vendor,
      os,
      env,
      format,
      linkMode,
      isWindows,
      isLinux,
      isWasm,
      isDarwin,
      isShared,
      relocMode,
      dataLayout,
      outputExtension,
      linkerFlavor,
    };
  }

  static findGccDir() {
    const baseGccDirs = [
      "/usr/lib/gcc/x86_64-pc-linux-gnu",
      "/usr/lib/gcc/x86_64-linux-gnu",
      "/usr/lib64/gcc/x86_64-pc-linux-gnu",
      "/usr/lib/gcc",
    ];
    for (const base of baseGccDirs) {
      if (existsSync(base)) {
        try {
          const entries = fs.readdirSync(base);
          entries.sort().reverse();
          for (const entry of entries) {
            const cand = path.join(base, entry);
            if (existsSync(path.join(cand, "crtbeginS.o"))) {
              return cand;
            }
          }
        } catch (e) {}
      }
    }
    return null;
  }

  /**
   * Hedef platforma özel LLD bağlayıcı (linker) argümanlarını üretir.
   */
  static getLinkerArgs(targetInfo, objFile, outputFile, options = {}) {
    const { linkerFlavor, format, isShared } = targetInfo;

    // 1. Linux/FreeBSD ELF Linker (ld.lld)
    if (linkerFlavor === "link_elf") {
      if (format === "elf") {
        const linkMode = targetInfo.linkMode || "dynamic";
        const crtDirs = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu"];
        const crtDir = crtDirs.find((d) => existsSync(`${d}/crt1.o`) || existsSync(`${d}/Scrt1.o`)) || "/usr/lib";
        const gccDir = this.findGccDir();

        let crt1 = `${crtDir}/crt1.o`;
        let crtbegin = gccDir && existsSync(`${gccDir}/crtbeginT.o`) ? `${gccDir}/crtbeginT.o` : null;
        let crtend = gccDir && existsSync(`${gccDir}/crtend.o`) ? `${gccDir}/crtend.o` : null;

        if (linkMode !== "static") {
          crt1 = existsSync(`${crtDir}/Scrt1.o`) ? `${crtDir}/Scrt1.o` : `${crtDir}/crt1.o`;
          crtbegin = gccDir && existsSync(`${gccDir}/crtbeginS.o`) ? `${gccDir}/crtbeginS.o` : null;
          crtend = gccDir && existsSync(`${gccDir}/crtendS.o`) ? `${gccDir}/crtendS.o` : null;
        }

        const crti = `${crtDir}/crti.o`;
        const crtn = `${crtDir}/crtn.o`;

        const extraLibDirs = options.extraLibDirs || [];
        const extraLibs = options.extraLibs || [];
        const isBuildingRypec = outputFile.includes("rypec") || extraLibDirs.some((d) => d.includes("llvm-rype"));

        const nativeArgs = [];
        if (options.nativeLibs && options.nativeLibs.length > 0) {
          for (let libPath of options.nativeLibs) {
            if (libPath.includes("liboxc_parser")) {
              continue; // Handled explicitly below
            }
            const aPath = libPath.replace(/\.(so|dylib)$/, ".a");
            if ((linkMode === "standalone" || linkMode === "static") && existsSync(aPath)) {
              nativeArgs.push(aPath);
            } else {
              const libDir = path.dirname(libPath);
              nativeArgs.push(`-L${libDir}`);
              if (linkMode !== "static") {
                nativeArgs.push(`-rpath=${libDir}`);
              }
              nativeArgs.push(libPath);
            }
          }
        }

        const args = [];

        if (linkMode === "static") {
          args.push("-static");
        } else {
          args.push("-pie", "-dynamic-linker", "/lib64/ld-linux-x86-64.so.2");
        }

        args.push(crt1, crti);
        if (crtbegin) {
          args.push(crtbegin);
        }
        args.push(objFile);

        if (isBuildingRypec) {
          const bridgeObj = path.resolve(process.cwd(), "bridge.o");
          if (existsSync(bridgeObj)) {
            args.push(bridgeObj);
          }

          if (linkMode === "dynamic") {
            const oxcSo = path.resolve(process.cwd(), "bin/liboxc_parser.so");
            if (existsSync(oxcSo)) {
              args.push(oxcSo);
            } else if (existsSync(path.resolve(process.cwd(), "bin/liboxc_parser.a"))) {
              args.push(path.resolve(process.cwd(), "bin/liboxc_parser.a"));
            }
          } else {
            const oxcA = path.resolve(process.cwd(), "bin/liboxc_parser.a");
            if (existsSync(oxcA)) {
              args.push(oxcA);
            } else if (existsSync(path.resolve(process.cwd(), "bin/liboxc_parser.so"))) {
              args.push(path.resolve(process.cwd(), "bin/liboxc_parser.so"));
            }
          }

          if (existsSync("bin/llvm_libs.rsp")) {
            args.push("@bin/llvm_libs.rsp");
          } else {
            const llvmLibDir = extraLibDirs.find((d) => d.includes("llvm-rype")) || (existsSync("/opt/llvm-rype/lib") ? "/opt/llvm-rype/lib" : null);
            if (llvmLibDir && existsSync(llvmLibDir)) {
              const archives = fs.readdirSync(llvmLibDir)
                .filter((f) => f.endsWith(".a"))
                .map((f) => path.join(llvmLibDir, f));
              args.push("--start-group");
              args.push(...archives);
              args.push("--end-group");
            }
          }
        }

        args.push(...nativeArgs);

        args.push(`-L${crtDir}`);
        if (gccDir) {
          args.push(`-L${gccDir}`);
        }
        for (const dir of extraLibDirs) {
          args.push(`-L${dir}`);
        }
        if (isBuildingRypec && linkMode !== "static") {
          args.push("-rpath=$ORIGIN");
        }

        if (linkMode === "static") {
          args.push("--start-group");
          if (isBuildingRypec) {
            args.push(
              "-lstdc++",
              "-lgcc",
              "-lgcc_eh",
              "-lz",
              "-lzstd",
              "-lxml2"
            );
          }
          args.push(
            "-lc",
            "-lm",
            "-lpthread",
            "-ldl",
            "-lgcc",
            "-lgcc_eh"
          );
          for (const lib of extraLibs) {
            args.push(`-l${lib}`);
          }
          args.push("--end-group");
        } else if (linkMode === "standalone") {
          args.push("-Bstatic", "-lstdc++", "-lgcc", "-lgcc_eh", "-Bdynamic");
          if (isBuildingRypec) {
            args.push(
              "-lz",
              "-lzstd",
              "-lxml2",
              "-lpthread",
              "-ldl",
              "-lm",
              "-lc"
            );
          } else {
            args.push("-lc", "-lm", "-lpthread", "-ldl");
          }
          for (const lib of extraLibs) {
            args.push(`-l${lib}`);
          }
        } else {
          if (isBuildingRypec) {
            args.push(
              "-lstdc++",
              "-lgcc",
              "-lgcc_s",
              "-lz",
              "-lzstd",
              "-lxml2",
              "-lpthread",
              "-ldl",
              "-lm",
              "-lc"
            );
          } else {
            args.push("-lc", "-lm", "-lpthread");
          }
          for (const lib of extraLibs) {
            args.push(`-l${lib}`);
          }
        }

        if (crtend) {
          args.push(crtend);
        }
        args.push(crtn);
        args.push("-o", outputFile);

        return args;
      }

      // Format: so veya node
      const searchDirs = [
        "/usr/lib",
        "/usr/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/lib/x86_64-linux-gnu",
        "/lib64",
        "/lib",
      ].filter((d) => existsSync(d));

      return [
        "-shared",
        objFile,
        ...searchDirs.map((d) => `-L${d}`),
        ...(options.extraLibDirs || []).map((d) => `-L${d}`),
        "-lc",
        "-lm",
        "-lpthread",
        ...(options.extraLibs || []).map((l) => `-l${l}`),
        "-o", outputFile,
      ];
    }

    // 2. WebAssembly Linker (wasm-ld)
    if (linkerFlavor === "link_wasm") {
      return [
        objFile,
        "-o", outputFile,
        "--no-entry",
        "--export-all",
        "--allow-undefined",
      ];
    }

    // 3. Windows PE/COFF Linker (lld-link)
    if (linkerFlavor === "link_coff") {
      if (isShared || format === "dll") {
        return [
          objFile,
          `/out:${outputFile}`,
          "/dll",
          "/noentry",
        ];
      }
      return [
        objFile,
        `/out:${outputFile}`,
        "/entry:main",
        "/subsystem:console",
        "/nodefaultlib",
      ];
    }

    // 4. Windows MinGW Linker (ld.lld -m i386pep)
    if (linkerFlavor === "link_mingw") {
      const archFlag = targetInfo.arch === "i686" || targetInfo.arch === "i386" ? "i386pe" : "i386pep";
      const extraLibDirs = options.extraLibDirs || [];
      const extraLibs = options.extraLibs || [];
      const defaultDirs = [
        "/usr/x86_64-w64-mingw32/lib",
        "/usr/lib/gcc/x86_64-w64-mingw32",
        "/usr/lib/wine/x86_64-windows",
      ];
      const allDirs = [...extraLibDirs, ...defaultDirs.filter((d) => existsSync(d))];
      const libDirArgs = allDirs.map((d) => `-L${d}`);

      if (isShared || format === "dll") {
        return [
          "-m", archFlag,
          "--shared",
          "-o", outputFile,
          objFile,
          ...libDirArgs,
          "-lkernel32",
          "-lmsvcrt",
          "-lcompiler-rt",
          ...extraLibs.map((l) => `-l${l}`),
        ];
      }
      return [
        "-m", archFlag,
        "-o", outputFile,
        objFile,
        "--entry=main",
        "--subsystem=console",
        ...libDirArgs,
        "-lmsvcrt",
        "-lkernel32",
        "-lcompiler-rt",
        ...extraLibs.map((l) => `-l${l}`),
      ];
    }

    // 5. macOS Mach-O Linker (ld64.lld)
    if (linkerFlavor === "link_macho") {
      if (isShared || format === "dylib") {
        return ["-dylib", "-o", outputFile, objFile, "-lSystem"];
      }
      return ["-o", outputFile, objFile, "-lSystem"];
    }

    throw new Error(`[TargetManager] Desteklenmeyen linker aroması: ${linkerFlavor}`);
  }
}
