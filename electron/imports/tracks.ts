interface Element {
  id: string;
  start: number;
  end: number;
}

function invalid(): never {
  throw new Error("The recording has invalid or unsupported track metadata. Choose an MP4 or WebM with one video track and at most one audio track.");
}

function mp4Boxes(data: Buffer, start: number, end: number): Element[] {
  const result: Element[] = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end || result.length >= 10_000) invalid();
    let length = data.readUInt32BE(offset);
    const id = data.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (length === 1) {
      if (offset + 16 > end) invalid();
      const wide = data.readBigUInt64BE(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      length = Number(wide);
      header = 16;
    } else if (length === 0) length = end - offset;
    if (length < header || offset + length > end) invalid();
    result.push({ id, start: offset + header, end: offset + length });
    offset += length;
  }
  return result;
}

function mp4Tracks(data: Buffer): number[] {
  const top = mp4Boxes(data, 0, data.length);
  if (!top.some((box) => box.id === "ftyp")) invalid();
  const movie = top.find((box) => box.id === "moov");
  if (!movie) invalid();
  return mp4Boxes(data, movie.start, movie.end)
    .filter((box) => box.id === "trak")
    .map((track) => {
      const media = mp4Boxes(data, track.start, track.end).find((box) => box.id === "mdia");
      if (!media) invalid();
      const mediaBoxes = mp4Boxes(data, media.start, media.end);
      const handler = mediaBoxes.find((box) => box.id === "hdlr");
      if (!handler || handler.start + 12 > handler.end) invalid();
      const type = data.toString("ascii", handler.start + 8, handler.start + 12);
      if (type === "vide" || type === "soun") {
        const info = mediaBoxes.find((box) => box.id === "minf");
        if (!info) invalid();
        const table = mp4Boxes(data, info.start, info.end).find((box) => box.id === "stbl");
        if (!table) invalid();
        const description = mp4Boxes(data, table.start, table.end).find((box) => box.id === "stsd");
        if (!description || description.start + 8 > description.end ||
            data.readUInt32BE(description.start + 4) !== 1) invalid();
        const entries = mp4Boxes(data, description.start + 8, description.end);
        const entry = entries[0];
        const allowed = type === "soun" ? ["mp4a", "Opus"] : ["avc1", "avc3", "hvc1", "hev1", "vp09", "av01"];
        if (entries.length !== 1 || !allowed.includes(entry.id)) {
          throw new Error(`Unsupported or encrypted MP4 ${type === "soun" ? "audio" : "video"} codec.`);
        }
        if (type === "soun") {
          if (entry.start + 28 > entry.end) invalid();
          validateAudio(data.readUInt16BE(entry.start + 16), data.readUInt32BE(entry.start + 24) / 65536);
        }
      }
      return type === "vide" ? 1 : type === "soun" ? 2 : 0;
    });
}

function vint(data: Buffer, offset: number, end: number, id: boolean) {
  if (offset >= end || data[offset] === 0) invalid();
  let length = 1;
  let mask = 0x80;
  while (!(data[offset] & mask)) { length++; mask >>= 1; }
  if (length > (id ? 4 : 8) || offset + length > end) invalid();
  let value = BigInt(id ? data[offset] : data[offset] & (mask - 1));
  for (let index = 1; index < length; index++) value = (value << 8n) | BigInt(data[offset + index]);
  const unknown = !id && value === (1n << BigInt(7 * length)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return { length, value: Number(value), unknown };
}

function webmElements(data: Buffer, start: number, end: number, stopAtCluster = false): Element[] {
  const result: Element[] = [];
  for (let offset = start; offset < end;) {
    if (result.length >= 10_000) invalid();
    const id = vint(data, offset, end, true);
    const size = vint(data, offset + id.length, end, false);
    const body = offset + id.length + size.length;
    const next = size.unknown ? end : body + size.value;
    if (next > end || next < body) invalid();
    const name = id.value.toString(16);
    if (stopAtCluster && name === "1f43b675") break;
    result.push({ id: name, start: body, end: next });
    offset = next;
  }
  return result;
}

function webmTracks(data: Buffer): number[] {
  const top = webmElements(data, 0, data.length);
  const header = top.find((element) => element.id === "1a45dfa3");
  const segment = top.find((element) => element.id === "18538067");
  if (!header || !segment) invalid();
  const doc = webmElements(data, header.start, header.end).find((element) => element.id === "4282");
  if (!doc || data.toString("ascii", doc.start, doc.end) !== "webm") invalid();
  const tracks = webmElements(data, segment.start, segment.end, true)
    .find((element) => element.id === "1654ae6b");
  if (!tracks) invalid();
  return webmElements(data, tracks.start, tracks.end)
    .filter((element) => element.id === "ae")
    .map((track) => {
      const fields = webmElements(data, track.start, track.end);
      if (fields.some((field) => field.id === "6d80")) {
        throw new Error("Encrypted or compressed WebM tracks cannot be imported.");
      }
      const type = fields.find((field) => field.id === "83");
      if (!type || type.end - type.start !== 1) invalid();
      const codec = fields.find((field) => field.id === "86");
      if (!codec) invalid();
      const codecId = data.toString("ascii", codec.start, codec.end);
      if (data[type.start] === 1 && !["V_VP8", "V_VP9", "V_AV1"].includes(codecId) ||
          data[type.start] === 2 && !["A_OPUS", "A_VORBIS"].includes(codecId)) {
        throw new Error("Unsupported WebM audio or video codec.");
      }
      if (data[type.start] === 2) {
        const audio = fields.find((field) => field.id === "e1");
        if (!audio) invalid();
        const settings = webmElements(data, audio.start, audio.end);
        const channels = settings.find((field) => field.id === "9f");
        const rate = settings.find((field) => field.id === "b5");
        if (channels && channels.end - channels.start > 4) invalid();
        const count = channels ? data.readUIntBE(channels.start, channels.end - channels.start) : 1;
        const sampleRate = !rate ? 8000 : rate.end - rate.start === 4 ? data.readFloatBE(rate.start)
          : rate.end - rate.start === 8 ? data.readDoubleBE(rate.start) : invalid();
        validateAudio(count, sampleRate);
      }
      return data[type.start];
    });
}

function validateAudio(channels: number, sampleRate: number): void {
  if (!Number.isInteger(channels) || channels < 1 || channels > 2 ||
      !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 48_000) {
    throw new Error("Imported audio must be mono or stereo at no more than 48 kHz.");
  }
}

/** Container metadata distinguishes absent audio from a codec Chromium silently ignores. */
export function inspectImportTracks(data: Buffer, extension: string): { hasAudio: boolean } {
  const tracks = extension === ".mp4" ? mp4Tracks(data) : extension === ".webm" ? webmTracks(data) : invalid();
  if (tracks.filter((type) => type === 1).length !== 1 ||
      tracks.filter((type) => type === 2).length > 1) invalid();
  return { hasAudio: tracks.includes(2) };
}
