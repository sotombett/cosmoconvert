import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// =========================================================================
// НАТИВНАЯ КОНВЕРТАЦИЯ ДОКУМЕНТОВ (LibreOffice / Microsoft Word COM)
// Сохраняет 100% оригинальное форматирование, таблицы, картинки и шрифты
// =========================================================================

let cachedSofficePath = undefined;
let cachedWordAvailable = undefined;

async function resolveSofficePath() {
  if (cachedSofficePath !== undefined) return cachedSofficePath;

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        'soffice'
      ]
    : ['soffice', 'libreoffice'];

  for (const bin of candidates) {
    try {
      if (bin.includes('\\') && !fs.existsSync(bin)) continue;
      await execFileAsync(bin, ['--version'], { timeout: 4000 });
      cachedSofficePath = bin;
      return cachedSofficePath;
    } catch {}
  }

  cachedSofficePath = null;
  return null;
}

async function convertViaLibreOffice(inputBuffer, srcExt, targetExt) {
  const soffice = await resolveSofficePath();
  if (!soffice) return null;

  const tmpDir = path.join(os.tmpdir(), `cc_lo_${crypto.randomBytes(6).toString('hex')}`);
  const safeSrc = srcExt.replace(/[^a-z0-9]/gi, '') || 'docx';
  const inPath = path.join(tmpDir, `input.${safeSrc}`);
  const outPath = path.join(tmpDir, `input.${targetExt}`);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(inPath, inputBuffer);

    await execFileAsync(
      soffice,
      ['--headless', '--nologo', '--nofirststartwizard', '--convert-to', targetExt, '--outdir', tmpDir, inPath],
      { timeout: 45000 }
    );

    if (fs.existsSync(outPath)) {
      return { buffer: fs.readFileSync(outPath), engine: 'LibreOffice' };
    }
    return null;
  } catch (err) {
    console.error('[CosmoConvert LibreOffice]', err.message);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

async function convertViaMsWord(inputBuffer, srcExt, targetExt) {
  if (process.platform !== 'win32') return null;
  if (cachedWordAvailable === false) return null;

  const wordTargets = {
    pdf: { mode: 'pdf', code: 17 },
    docx: { mode: 'saveas', code: 16 },
    doc: { mode: 'saveas', code: 0 },
    html: { mode: 'saveas', code: 10 },
    txt: { mode: 'saveas', code: 7 }
  };

  const spec = wordTargets[targetExt];
  if (!spec) return null;

  const supportedSources = ['docx', 'doc', 'rtf', 'odt', 'html', 'htm', 'txt', 'pdf'];
  if (!supportedSources.includes(srcExt)) return null;
  if (srcExt === 'pdf' && targetExt === 'pdf') return null;

  const tmpId = crypto.randomBytes(6).toString('hex');
  const safeSrc = srcExt.replace(/[^a-z0-9]/gi, '') || 'docx';
  const inPath = path.join(os.tmpdir(), `cc_wd_in_${tmpId}.${safeSrc}`);
  const outPath = path.join(os.tmpdir(), `cc_wd_out_${tmpId}.${targetExt}`);

  const psScript = spec.mode === 'pdf'
    ? `
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:CC_IN_PATH, $false, $true, $false)
  $doc.ExportAsFixedFormat($env:CC_OUT_PATH, 17)
} finally {
  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }
  if ($word -ne $null) { try { $word.Quit($false) } catch {}; try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {} }
}
`
    : `
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:CC_IN_PATH, $false, $true, $false)
  $doc.SaveAs2($env:CC_OUT_PATH, ${spec.code})
} finally {
  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }
  if ($word -ne $null) { try { $word.Quit($false) } catch {}; try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {} }
}
`;

  try {
    fs.writeFileSync(inPath, inputBuffer);
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        timeout: 35000,
        env: { ...process.env, CC_IN_PATH: inPath, CC_OUT_PATH: outPath }
      }
    );

    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      cachedWordAvailable = true;
      return { buffer: fs.readFileSync(outPath), engine: 'MS Word' };
    }
    return null;
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    if (stderr.includes('Word.Application') || stderr.includes('80040154') || stderr.includes('COM')) {
      cachedWordAvailable = false;
    }
    console.warn('[CosmoConvert Word COM]', stderr.split('\n')[0]);
    return null;
  } finally {
    if (fs.existsSync(inPath)) { try { fs.unlinkSync(inPath); } catch {} }
    if (fs.existsSync(outPath)) { try { fs.unlinkSync(outPath); } catch {} }
  }
}

export async function convertDocumentNatively(inputBuffer, srcExt, targetExt) {
  const s = String(srcExt || '').toLowerCase();
  const t = String(targetExt || '').toLowerCase();
  if (!['pdf', 'docx', 'doc', 'html'].includes(t)) return null;

  // 1. Пробуем LibreOffice (быстро и кроссплатформенно)
  const loRes = await convertViaLibreOffice(inputBuffer, s, t);
  if (loRes) return loRes;

  // 2. На Windows пробуем установленный Microsoft Word (100% точность верстки DOCX -> PDF)
  const wordRes = await convertViaMsWord(inputBuffer, s, t);
  if (wordRes) return wordRes;

  return null;
}

// =========================================================================
// МИНИМАЛЬНЫЙ ZIP-ПАРСЕР И СБОРЩИК (для DOCX и ODT без сторонних библиотек)
// =========================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function readZipEntries(zipBuf) {
  const entries = new Map();
  let eocdOffset = -1;
  const searchStart = Math.max(0, zipBuf.length - 65558);
  for (let i = zipBuf.length - 22; i >= searchStart; i--) {
    if (
      zipBuf[i] === 0x50 &&
      zipBuf[i + 1] === 0x4b &&
      zipBuf[i + 2] === 0x05 &&
      zipBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const cdCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  let pos = cdOffset;

  for (let i = 0; i < cdCount && pos + 46 <= zipBuf.length; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const fileName = zipBuf.toString('utf-8', pos + 46, pos + 46 + nameLen);

    pos += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > zipBuf.length) continue;
    if (zipBuf.readUInt32LE(localOffset) !== 0x04034b50) continue;

    const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = Math.min(zipBuf.length, dataStart + compSize);
    const rawSlice = zipBuf.subarray(dataStart, dataEnd);

    try {
      if (method === 0) {
        entries.set(fileName, Buffer.from(rawSlice));
      } else if (method === 8) {
        entries.set(fileName, zlib.inflateRawSync(rawSlice));
      }
    } catch {}
  }

  return entries;
}

export function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf-8');
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf-8');
    const crc = crc32(dataBuf);
    const compBuf = zlib.deflateRawSync(dataBuf, { level: 6 });

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0x0800, 6);
    localHdr.writeUInt16LE(8, 8);
    localHdr.writeUInt16LE(0, 10);
    localHdr.writeUInt16LE(0, 12);
    localHdr.writeUInt32LE(crc, 14);
    localHdr.writeUInt32LE(compBuf.length, 18);
    localHdr.writeUInt32LE(dataBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localParts.push(localHdr, nameBuf, compBuf);

    const centralHdr = Buffer.alloc(46);
    centralHdr.writeUInt32LE(0x02014b50, 0);
    centralHdr.writeUInt16LE(20, 4);
    centralHdr.writeUInt16LE(20, 6);
    centralHdr.writeUInt16LE(0x0800, 8);
    centralHdr.writeUInt16LE(8, 10);
    centralHdr.writeUInt16LE(0, 12);
    centralHdr.writeUInt16LE(0, 14);
    centralHdr.writeUInt32LE(crc, 16);
    centralHdr.writeUInt32LE(compBuf.length, 20);
    centralHdr.writeUInt32LE(dataBuf.length, 24);
    centralHdr.writeUInt16LE(nameBuf.length, 28);
    centralHdr.writeUInt16LE(0, 30);
    centralHdr.writeUInt16LE(0, 32);
    centralHdr.writeUInt16LE(0, 34);
    centralHdr.writeUInt16LE(0, 36);
    centralHdr.writeUInt32LE(0, 38);
    centralHdr.writeUInt32LE(offset, 42);

    centralParts.push(centralHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

// =========================================================================
// ИЗВЛЕЧЕНИЕ ТЕКСТА ИЗ DOCX, ODT, PDF, RTF, DOC, HTML, TXT
// =========================================================================

function decodeXmlEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractParagraphText(pXml) {
  let out = '';
  // Токенизируем все текстовые и пробельные элементы Word XML в строгом порядке следования
  const tokenRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|ptab|br|cr|noBreakHyphen|softHyphen)\b[^>]*\/?>/g;
  let m;
  while ((m = tokenRe.exec(pXml)) !== null) {
    if (m[1] !== undefined) {
      const piece = decodeXmlEntities(m[1]).replace(/[\u00A0\u2002\u2003\u2009\u202F]/g, ' ');
      out += piece;
    } else if (m[2] === 'tab' || m[2] === 'ptab') {
      if (out.length > 0 && !/\s$/.test(out)) out += ' ';
    } else if (m[2] === 'br' || m[2] === 'cr') {
      out += '\n';
    } else if (m[2] === 'noBreakHyphen') {
      out += '-';
    }
  }
  return out
    .split('\n')
    .map(l => l.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n');
}

export function extractTextFromDocx(buf) {
  const entries = readZipEntries(buf);
  const docXmlBuf = entries.get('word/document.xml');
  if (!docXmlBuf) return '';

  // Убираем дубликаты mc:Fallback и удаленные правки w:del
  let xml = docXmlBuf
    .toString('utf-8')
    .replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '')
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '');

  // Собираем строки таблиц аккуратно (ячейки через " | ")
  const blocks = [];
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  // Разбираем верхний уровень: таблицы <w:tbl> и абзацы <w:p>
  const topRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let tm;
  while ((tm = topRe.exec(bodyXml)) !== null) {
    const chunk = tm[0];
    if (chunk.startsWith('<w:tbl')) {
      const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
      let rm;
      while ((rm = rowRe.exec(chunk)) !== null) {
        const cells = [];
        const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let cm;
        while ((cm = cellRe.exec(rm[1])) !== null) {
          const cellPs = [];
          const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
          let pm;
          while ((pm = pRe.exec(cm[1])) !== null) {
            const txt = extractParagraphText(pm[1]);
            if (txt) cellPs.push(txt);
          }
          cells.push(cellPs.join(' '));
        }
        const rowLine = cells.join(' | ').trim();
        if (rowLine) blocks.push(rowLine);
      }
      blocks.push('');
    } else {
      const text = extractParagraphText(chunk);
      blocks.push(text);
    }
  }

  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTextFromOdt(buf) {
  const entries = readZipEntries(buf);
  const contentBuf = entries.get('content.xml');
  if (!contentBuf) return '';
  const xml = contentBuf.toString('utf-8');
  return decodeXmlEntities(
    xml
      .replace(/<text:s\s*\/>/g, ' ')
      .replace(/<text:line-break\s*\/>/g, '\n')
      .replace(/<text:tab\s*\/>/g, ' ')
      .replace(/<\/text:p>|<\/text:h>/g, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeWin1251Byte(b) {
  if (b < 0x80) return String.fromCharCode(b);
  if (b >= 0xc0 && b <= 0xff) return String.fromCharCode(0x0410 + (b - 0xc0));
  if (b === 0xa8) return 'Ё';
  if (b === 0xb8) return 'ё';
  const extras = {
    0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
    0x95: '•', 0x96: '–', 0x97: '—', 0xab: '«', 0xbb: '»', 0xb9: '№'
  };
  return extras[b] || ' ';
}

export function extractTextFromRtf(buf) {
  let s = buf.toString('latin1');
  s = s.replace(/\{\\\*\\[^{}]*\}/g, '');
  s = s.replace(/\\par[d]?\b/g, '\n').replace(/\\line\b/g, '\n').replace(/\\tab\b/g, ' ');
  s = s.replace(/\\u(-?\d+)\??/g, (_, num) => {
    let code = parseInt(num, 10);
    if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => decodeWin1251Byte(parseInt(hex, 16)));
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function decodePdfHex(hexStr, cmap) {
  const clean = hexStr.replace(/\s+/g, '');
  if (!clean) return '';

  if (cmap && cmap.size > 0) {
    let out = '';
    const step = clean.length % 4 === 0 ? 4 : 2;
    let matched = 0;
    for (let i = 0; i < clean.length; i += step) {
      const key = clean.slice(i, i + step).toUpperCase();
      if (cmap.has(key)) {
        out += cmap.get(key);
        matched++;
      } else if (step === 4 && cmap.has(key.slice(0, 2)) && cmap.has(key.slice(2, 4))) {
        out += cmap.get(key.slice(0, 2)) + cmap.get(key.slice(2, 4));
        matched++;
      } else {
        const code = parseInt(key, 16);
        if (code >= 32) out += String.fromCharCode(code);
      }
    }
    if (matched > 0) return out;
  }

  if (clean.length >= 4 && (clean.toUpperCase().startsWith('FEFF') || clean.length % 4 === 0)) {
    const start = clean.toUpperCase().startsWith('FEFF') ? 4 : 0;
    let out = '';
    for (let i = start; i + 3 < clean.length; i += 4) {
      const code = parseInt(clean.slice(i, i + 4), 16);
      if (code >= 9) out += String.fromCharCode(code);
    }
    if (out.trim()) return out;
  }

  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (b >= 32) out += String.fromCharCode(b);
  }
  return out;
}

function unescapePdfLiteral(str) {
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function parseToUnicodeCMap(streamText, cmap) {
  const bfCharBlocks = streamText.match(/beginbfchar[\s\S]*?endbfchar/g) || [];
  for (const blk of bfCharBlocks) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(blk)) !== null) {
      const src = m[1].toUpperCase();
      const dstHex = m[2];
      let ch = '';
      for (let i = 0; i + 3 < dstHex.length; i += 4) {
        ch += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16));
      }
      if (!ch && dstHex.length === 2) ch = String.fromCharCode(parseInt(dstHex, 16));
      if (ch) cmap.set(src, ch);
    }
  }

  const bfRangeBlocks = streamText.match(/beginbfrange[\s\S]*?endbfrange/g) || [];
  for (const blk of bfRangeBlocks) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(blk)) !== null) {
      const startCode = parseInt(m[1], 16);
      const endCode = parseInt(m[2], 16);
      let dstCode = parseInt(m[3], 16);
      const padLen = m[1].length;
      if (endCode - startCode <= 512) {
        for (let c = startCode; c <= endCode; c++) {
          const key = c.toString(16).toUpperCase().padStart(padLen, '0');
          cmap.set(key, String.fromCharCode(dstCode++));
        }
      }
    }
  }
}

export function extractTextFromPdf(buf) {
  const latin = buf.toString('latin1');
  const decodedStreams = [];
  const cmap = new Map();

  const streamRe = /stream\r?\n([\s\S]*?)\r?\n?endstream/g;
  let sm;
  while ((sm = streamRe.exec(latin)) !== null) {
    const rawStr = sm[1];
    const rawBytes = Buffer.from(rawStr, 'latin1');
    let textStream = '';

    try {
      textStream = zlib.inflateSync(rawBytes).toString('latin1');
    } catch {
      try {
        textStream = zlib.inflateRawSync(rawBytes).toString('latin1');
      } catch {
        textStream = rawStr;
      }
    }

    if (textStream.includes('beginbfchar') || textStream.includes('beginbfrange')) {
      parseToUnicodeCMap(textStream, cmap);
    } else if (textStream.includes('BT') && textStream.includes('ET')) {
      decodedStreams.push(textStream);
    }
  }

  const lines = [];
  for (const st of decodedStreams) {
    const btBlocks = st.match(/BT[\s\S]*?ET/g) || [];
    for (const blk of btBlocks) {
      let chunk = '';
      const opRe = /\[([\s\S]*?)\]\s*TJ|\(([^()]*(?:\\.[^()]*)*)\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|(T\*|TD|Td)/g;
      let om;
      while ((om = opRe.exec(blk)) !== null) {
        if (om[1] !== undefined) {
          const innerRe = /\(([^()]*(?:\\.[^()]*)*)\)|<([0-9a-fA-F\s]+)>|(-?\d+(?:\.\d+)?)/g;
          let im;
          while ((im = innerRe.exec(om[1])) !== null) {
            if (im[1] !== undefined) chunk += unescapePdfLiteral(im[1]);
            else if (im[2] !== undefined) chunk += decodePdfHex(im[2], cmap);
            else if (im[3] !== undefined && Number(im[3]) < -180) chunk += ' ';
          }
        } else if (om[2] !== undefined) {
          chunk += unescapePdfLiteral(om[2]);
        } else if (om[3] !== undefined) {
          chunk += decodePdfHex(om[3], cmap);
        } else if (om[4] !== undefined) {
          chunk += '\n';
        }
      }
      if (chunk.trim()) lines.push(chunk.trim());
    }
  }

  const result = lines.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (result.length > 0) return result;
  return '[PDF-документ загружен. Текстовый слой не обнаружен или документ состоит из отсканированных изображений.]';
}

export function extractTextFromLegacyDoc(buf) {
  const head = buf.subarray(0, 512).toString('utf-8');
  if (head.includes('<html') || head.includes('<HTML') || head.includes('<!DOCTYPE')) {
    return buf.toString('utf-8')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/li>|<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (head.startsWith('{\\rtf')) {
    return extractTextFromRtf(buf);
  }
  const u16 = buf.toString('utf16le');
  const matches = u16.match(/[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 ,.;:!?()\-—«»"'\r\n]{12,}/g) || [];
  if (matches.length > 0) {
    return matches.join('\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return buf.toString('utf-8').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}

export function extractDocumentText(buf, originalName) {
  const ext = (String(originalName || '').split('.').pop() || 'txt').toLowerCase();
  if (ext === 'docx') return extractTextFromDocx(buf);
  if (ext === 'odt') return extractTextFromOdt(buf);
  if (ext === 'pdf') return extractTextFromPdf(buf);
  if (ext === 'rtf') return extractTextFromRtf(buf);
  if (ext === 'doc') return extractTextFromLegacyDoc(buf);
  return buf.toString('utf-8').replace(/^\uFEFF/, '');
}

// =========================================================================
// ГЕНЕРАЦИЯ НАСТОЯЩЕГО DOCX (OOXML ZIP)
// =========================================================================

export function buildDocxBuffer(plainText, title = 'CosmoConvert Document') {
  const lines = String(plainText || '').replace(/\r\n/g, '\n').split('\n');
  const pXml = lines.map(line => {
    const safe = escapeXml(line);
    if (!safe.trim()) return '<w:p/>';
    return `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  }).join('');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${pXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/document.xml', data: documentXml }
  ]);
}

// =========================================================================
// РЕЗЕРВНАЯ ГЕНЕРАЦИЯ МНОГОСТРАНИЧНОГО PDF С ПОЛНОЙ ПОДДЕРЖКОЙ КИРИЛЛИЦЫ (A4)
// =========================================================================

function wrapLinesForA4(text, maxChars = 74) {
  const result = [];
  const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');

  for (const rawLine of rawLines) {
    if (!rawLine.trim()) {
      result.push('');
      continue;
    }
    const words = rawLine.trim().split(/\s+/);
    let current = '';
    for (const word of words) {
      if (word.length > maxChars) {
        if (current) { result.push(current); current = ''; }
        for (let i = 0; i < word.length; i += maxChars) {
          result.push(word.slice(i, i + maxChars));
        }
      } else if (!current) {
        current = word;
      } else if (current.length + 1 + word.length <= maxChars) {
        current += ' ' + word;
      } else {
        result.push(current);
        current = word;
      }
    }
    if (current) result.push(current);
  }

  return result.length > 0 ? result : [''];
}

function packJpegsIntoPdf(jpegPages) {
  const numPages = jpegPages.length;
  const pageIds = [];
  for (let i = 0; i < numPages; i++) pageIds.push(5 + i * 3);

  const objects = [];
  objects.push({ id: 1, body: Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii') });
  objects.push({
    id: 2,
    body: Buffer.from(`<< /Type /Pages /Kids [ ${pageIds.map(id => `${id} 0 R`).join(' ')} ] /Count ${numPages} >>`, 'ascii')
  });

  for (let i = 0; i < numPages; i++) {
    const { w, h, data } = jpegPages[i];
    const imgId = 3 + i * 3;
    const cntId = 4 + i * 3;
    const pgId = 5 + i * 3;

    const imgHead = Buffer.from(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`,
      'ascii'
    );
    objects.push({ id: imgId, body: Buffer.concat([imgHead, data, Buffer.from('\nendstream', 'ascii')]) });

    const contentStream = Buffer.from('q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n', 'ascii');
    objects.push({
      id: cntId,
      body: Buffer.concat([
        Buffer.from(`<< /Length ${contentStream.length} >>\nstream\n`, 'ascii'),
        contentStream,
        Buffer.from('endstream', 'ascii')
      ])
    });

    objects.push({
      id: pgId,
      body: Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${cntId} 0 R >>`,
        'ascii'
      )
    });
  }

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let bytePos = chunks[0].length;
  const offsets = new Map();

  for (const obj of objects) {
    offsets.set(obj.id, bytePos);
    const open = Buffer.from(`${obj.id} 0 obj\n`, 'ascii');
    const close = Buffer.from('\nendobj\n', 'ascii');
    chunks.push(open, obj.body, close);
    bytePos += open.length + obj.body.length + close.length;
  }

  const xrefPos = bytePos;
  const maxId = 2 + numPages * 3;
  const xrefLines = [`xref\n0 ${maxId + 1}\n`, '0000000000 65535 f \n'];
  for (let oid = 1; oid <= maxId; oid++) {
    const off = offsets.get(oid) || 0;
    xrefLines.push(`${String(off).padStart(10, '0')} 00000 n \n`);
  }
  xrefLines.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  chunks.push(Buffer.from(xrefLines.join(''), 'ascii'));

  return Buffer.concat(chunks);
}

export async function buildPdfBuffer(plainText, title, sharp) {
  const PAGE_W = 1240;
  const PAGE_H = 1754;
  const MARGIN_X = 96;
  const START_Y = 104;
  const LINE_H = 34;
  const LINES_PER_PAGE = 45;

  const wrapped = wrapLinesForA4(plainText, 72);
  const maxPages = 40;
  const pagesText = [];
  for (let i = 0; i < wrapped.length && pagesText.length < maxPages; i += LINES_PER_PAGE) {
    pagesText.push(wrapped.slice(i, i + LINES_PER_PAGE));
  }
  if (pagesText.length === 0) pagesText.push(['']);

  const jpegPages = [];

  for (let p = 0; p < pagesText.length; p++) {
    const lines = pagesText[p];
    const tSpans = lines.map((line, idx) => {
      const y = START_Y + idx * LINE_H;
      const isHeading = p === 0 && idx === 0 && line.length > 0 && line.length < 70;
      const weight = isHeading ? 'bold' : 'normal';
      const size = isHeading ? 24 : 21;
      return `<text x="${MARGIN_X}" y="${y}" font-size="${size}" font-weight="${weight}" fill="#14182b" font-family="Segoe UI, Arial, DejaVu Sans, Liberation Sans, sans-serif" xml:space="preserve">${escapeXml(line)}</text>`;
    }).join('\n');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      ${tSpans}
      <text x="${PAGE_W - MARGIN_X}" y="${PAGE_H - 46}" text-anchor="end" font-size="16" fill="#6b7280" font-family="Segoe UI, Arial, DejaVu Sans, sans-serif">${p + 1} / ${pagesText.length}</text>
    </svg>`;

    const jpegBuf = await sharp(Buffer.from(svg, 'utf-8'))
      .jpeg({ quality: 92 })
      .toBuffer();

    jpegPages.push({ w: PAGE_W, h: PAGE_H, data: jpegBuf });
  }

  return packJpegsIntoPdf(jpegPages);
}

// =========================================================================
// ОЧИСТКА МЕТАДАННЫХ ИЗ DOCX (docProps/core.xml и docProps/app.xml)
// =========================================================================

export function stripDocxMetadata(buf) {
  const entries = readZipEntries(buf);
  if (entries.size === 0) return buf;

  const cleanCore = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator></dc:creator>
  <cp:lastModifiedBy></cp:lastModifiedBy>
</cp:coreProperties>`;

  const cleanApp = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>CosmoConvert</Application>
  <Company></Company>
</Properties>`;

  const outFiles = [];
  for (const [name, data] of entries.entries()) {
    if (name === 'docProps/core.xml') {
      outFiles.push({ name, data: Buffer.from(cleanCore, 'utf-8') });
    } else if (name === 'docProps/app.xml') {
      outFiles.push({ name, data: Buffer.from(cleanApp, 'utf-8') });
    } else {
      outFiles.push({ name, data });
    }
  }
  return createZipBuffer(outFiles);
}
