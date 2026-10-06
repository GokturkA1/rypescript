// std/buffer.ts
// RypeScript Standart Kütüphanesi - Ham Bellek ve Bayt Tamponu (Buffer)

export class Buffer {
  ptr: pointer;
  capacity: number;
  length: number;

  constructor(capacity: number) {
    let cap = capacity;
    if (cap <= 0) {
      cap = 1;
    }
    this.capacity = cap;
    this.length = 0;
    this.ptr = malloc(cap);
  }

  readU8(offset: number): i32 {
    return ptr_read_u8(this.ptr, offset);
  }

  writeU8(offset: number, val: number): void {
    ptr_write_u8(this.ptr, offset, val);
    let end = offset + 1;
    if (end > this.length) {
      this.length = end;
    }
  }

  readI32(offset: number): i32 {
    return ptr_read_i32(this.ptr, offset);
  }

  writeI32(offset: number, val: number): void {
    ptr_write_i32(this.ptr, offset, val);
    let end = offset + 4;
    if (end > this.length) {
      this.length = end;
    }
  }

  readF64(offset: number): f64 {
    return ptr_read_f64(this.ptr, offset);
  }

  writeF64(offset: number, val: number): void {
    ptr_write_f64(this.ptr, offset, val);
    let end = offset + 8;
    if (end > this.length) {
      this.length = end;
    }
  }

  toString(): string {
    let len = this.length;
    let strBuf: pointer = malloc(len + 1);
    for (let i = 0; i < len; i++) {
      let b = ptr_read_u8(this.ptr, i);
      ptr_write_u8(strBuf, i, b);
    }
    ptr_write_u8(strBuf, len, 0);
    return strBuf as string;
  }

  static fromString(text: string): Buffer {
    let len = text.length;
    let cap = len + 1;
    if (cap <= 0) {
      cap = 1;
    }
    let buf = new Buffer(cap);
    for (let i = 0; i < len; i++) {
      let ch = text.charCodeAt(i);
      buf.writeU8(i, ch);
    }
    buf.length = len;
    return buf;
  }

  slice(start: number, end: number): Buffer {
    let s = start;
    let e = end;
    if (s < 0) s = 0;
    if (e > this.length) e = this.length;
    let newLen = e - s;
    if (newLen < 0) newLen = 0;

    let cap = newLen;
    if (cap <= 0) {
      cap = 1;
    }
    let sub = new Buffer(cap);
    for (let i = 0; i < newLen; i++) {
      let b = ptr_read_u8(this.ptr, s + i);
      sub.writeU8(i, b);
    }
    sub.length = newLen;
    return sub;
  }

  dispose(): void {
    if (this.ptr !== null) {
      free(this.ptr);
      this.ptr = null;
    }
  }
}
