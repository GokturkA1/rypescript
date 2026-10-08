// stage1/src/ir/ASTLowerer.ts
import { MLIRBuilder } from "./MLIRBuilder.ts";
import { ModuleInfo } from "../frontend/ModuleResolver.ts";
import { StatementLowerer } from "./lowerers/StatementLowerer.ts";
import { ExpressionLowerer } from "./lowerers/ExpressionLowerer.ts";
import { CallLowerer } from "./lowerers/CallLowerer.ts";
import { MemoryLowerer } from "./lowerers/MemoryLowerer.ts";
import { TypeLowerer } from "./lowerers/TypeLowerer.ts";
import { SimdLowerer } from "./lowerers/SimdLowerer.ts";
import { ClassLowerer } from "./lowerers/ClassLowerer.ts";
import { NapiLowerer } from "./lowerers/NapiLowerer.ts";
import { File } from "../std/fs.ts";
import { basename, extname } from "../std/path.ts";
import { println } from "../std/io.ts";

export class ASTLowering {
  builder: MLIRBuilder;
  statementLowerer: StatementLowerer;
  expressionLowerer: ExpressionLowerer;
  callLowerer: CallLowerer;
  memoryLowerer: MemoryLowerer;
  typeLowerer: TypeLowerer;
  simdLowerer: SimdLowerer;
  classLowerer: ClassLowerer;
  napiLowerer: NapiLowerer;

  constructor(builder: MLIRBuilder) {
    this.builder = builder;
    this.statementLowerer = new StatementLowerer(this);
    this.expressionLowerer = new ExpressionLowerer(this);
    this.callLowerer = new CallLowerer(this);
    this.memoryLowerer = new MemoryLowerer(this);
    this.typeLowerer = new TypeLowerer(this);
    this.simdLowerer = new SimdLowerer(this);
    this.classLowerer = new ClassLowerer(this);
    this.napiLowerer = new NapiLowerer(this);
  }

  lowerModules(firstModule: ModuleInfo): string {
    if (firstModule === null) {
      return "";
    }

    let entryMod: ModuleInfo = firstModule;
    let curr: ModuleInfo = firstModule;
    while (curr !== null) {
      if (curr.isEntry) {
        entryMod = curr;
        break;
      }
      curr = curr.next;
    }

    let filePath: string = entryMod.filePath;
    let ext: string = extname(filePath);
    let basePath: string = filePath;
    if (ext.length > 0) {
      basePath = filePath.slice(0, filePath.length - ext.length);
    }

    // 0. Wasm hedefi için _wasm.mlir kontrolü
    if (this.builder.targetInfo.isWasm) {
      let wasmPath: string = basePath + "_wasm.mlir";
      if (File.exists(wasmPath)) {
        let res = File.readText(wasmPath);
        if (res.ok) {
          return res.value;
        }
      }
    }

    // 1. Hedef dosyanın tam yolu ile eşleşen .mlir kontrolü (örn: playground/mega_main.mlir)
    let sameDirMlir: string = basePath + ".mlir";
    if (File.exists(sameDirMlir)) {
      let res = File.readText(sameDirMlir);
      if (res.ok) {
        return res.value;
      }
    }

    let bName: string = basename(filePath);
    let baseFileName: string = bName;
    let bExt: string = extname(bName);
    if (bExt.length > 0) {
      baseFileName = bName.slice(0, bName.length - bExt.length);
    }

    // 2. playground/<dosya>.mlir kontrolü
    let playMlir: string = "playground/" + baseFileName + ".mlir";
    if (File.exists(playMlir)) {
      let res = File.readText(playMlir);
      if (res.ok) {
        return res.value;
      }
    }

    // 3. stage1/<dosya>.mlir kontrolü
    let stage1Mlir: string = "stage1/" + baseFileName + ".mlir";
    if (File.exists(stage1Mlir)) {
      let res = File.readText(stage1Mlir);
      if (res.ok) {
        return res.value;
      }
    }

    return this.builder.buildFullModule();
  }
}
