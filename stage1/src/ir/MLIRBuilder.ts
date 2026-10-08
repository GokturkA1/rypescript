// stage1/src/ir/MLIRBuilder.ts
import { StringBuilder } from "../std/stringbuilder.ts";
import { TargetInfo } from "../engine/TargetManager.ts";
import { RuntimeEmitters } from "../runtime/RuntimeEmitters.ts";

export class MLIRBuilder {
  targetInfo: TargetInfo;
  ssaCount: number;
  sb: StringBuilder;

  constructor(targetInfo: TargetInfo) {
    this.targetInfo = targetInfo;
    this.ssaCount = 0;
    this.sb = new StringBuilder(4096);
  }

  nextSSA(): string {
    let ssa: string = "%" + this.ssaCount;
    this.ssaCount = this.ssaCount + 1;
    return ssa;
  }

  emit(line: string): void {
    this.sb.append("    ");
    this.sb.appendLine(line);
  }

  emitRaw(line: string): void {
    this.sb.appendLine(line);
  }

  buildFullModule(): string {
    let moduleSb = new StringBuilder(this.sb.length + 512);
    moduleSb.appendLine("module {");
    RuntimeEmitters.emitStandardRuntime(moduleSb);
    moduleSb.append(this.sb.toString());
    moduleSb.appendLine("}");
    return moduleSb.toString();
  }
}
