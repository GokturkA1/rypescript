// stage1/src/runtime/HeaderGenerator.ts
import { StringBuilder } from "../std/stringbuilder.ts";

export class HeaderGenerator {
  static generate(guardName: string): string {
    let sb = new StringBuilder(256);
    sb.appendLine("#ifndef " + guardName + "_H");
    sb.appendLine("#define " + guardName + "_H");
    sb.appendLine("");
    sb.appendLine("#include <stdint.h>");
    sb.appendLine("#include <stdbool.h>");
    sb.appendLine("");
    sb.appendLine("#ifdef __cplusplus");
    sb.appendLine("extern \"C\" {");
    sb.appendLine("#endif");
    sb.appendLine("");
    sb.appendLine("#ifdef __cplusplus");
    sb.appendLine("}");
    sb.appendLine("#endif");
    sb.appendLine("");
    sb.appendLine("#endif // " + guardName + "_H");
    return sb.toString();
  }
}
