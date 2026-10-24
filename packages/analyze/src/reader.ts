// ServUO's GenericReader over a byte buffer (Server/Serialization.cs, BinaryFileReader): little
// endian, 7-bit encoded lengths, UTF-8 strings. World data strings carry a presence byte first
// (BinaryFileWriter with PrefixStrings); the type tables (.tdb) do not.
export class Reader {
  private readonly view: DataView;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly bytes: Uint8Array,
    public offset = 0
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  byte() {
    return this.view.getUint8(this.offset++);
  }
  sbyte() {
    return this.view.getInt8(this.offset++);
  }
  bool() {
    return this.byte() !== 0;
  }
  short() {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }
  int() {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }
  long() {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }
  encodedInt() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return value;
      shift += 7;
    }
  }
  // A string without the presence byte (.tdb type names, .NET BinaryWriter.Write(string)).
  rawString() {
    const length = this.encodedInt();
    const text = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return text;
  }
  string() {
    return this.bool() ? this.rawString() : undefined;
  }
  point() {
    return { x: this.int(), y: this.int(), z: this.int() };
  }
  // DateTime ticks (100 ns since 0001-01-01) as a JavaScript date.
  date() {
    return new Date(Number(this.long() / 10000n) - 62135596800000);
  }
  skip(bytes: number) {
    this.offset += bytes;
  }
}
