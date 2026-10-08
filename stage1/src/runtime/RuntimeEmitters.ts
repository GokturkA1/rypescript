// stage1/src/runtime/RuntimeEmitters.ts
import { StringBuilder } from "../std/stringbuilder.ts";

export class RuntimeEmitters {
  static emitStandardRuntime(sb: StringBuilder): void {
    // String concatenation helper
    sb.appendLine("  llvm.func @strlen(!llvm.ptr) -> i64");
    sb.appendLine("  llvm.func @malloc(i64) -> !llvm.ptr");
    sb.appendLine("  llvm.func @free(!llvm.ptr)");
    sb.appendLine("  llvm.func @memcpy(!llvm.ptr, !llvm.ptr, i64) -> !llvm.ptr");
    sb.appendLine("");
  }
}
