// std/fs.ts
// RypeScript Standart Kütüphanesi - Dosya Sistemi ve libc FFI

export declare function fopen(path: pointer, mode: pointer): pointer;
export declare function fclose(stream: pointer): i32;
export declare function fread(buf: pointer, size: i64, count: i64, stream: pointer): i64;
export declare function fwrite(buf: pointer, size: i64, count: i64, stream: pointer): i64;
export declare function fseek(stream: pointer, offset: i64, whence: i32): i32;
export declare function ftell(stream: pointer): i64;
export declare function remove(path: pointer): i32;

export class File {
  static readText(path: string): Result<string, string> {
    let fp = fopen(path, "rb");
    if (fp === null) {
      return Err("Dosya okunamadı");
    }
    // SEEK_END = 2
    fseek(fp, 0, 2);
    let size: i64 = ftell(fp);
    // SEEK_SET = 0
    fseek(fp, 0, 0);

    let buf: pointer = malloc(size + 1);
    let readCount: i64 = fread(buf, 1, size, fp);
    ptr_write_u8(buf, size, 0);
    fclose(fp);

    let text: string = buf as string;
    return Ok(text);
  }

  static writeText(path: string, content: string): Result<boolean, string> {
    let fp = fopen(path, "wb");
    if (fp === null) {
      return Err("Dosya yazılamadı");
    }
    let len: i64 = content.length;
    fwrite(content, 1, len, fp);
    fclose(fp);
    return Ok(true);
  }

  static exists(path: string): boolean {
    let fp = fopen(path, "rb");
    if (fp === null) {
      return false;
    }
    fclose(fp);
    return true;
  }

  static remove(path: string): boolean {
    let res = remove(path);
    return res === 0;
  }
}
