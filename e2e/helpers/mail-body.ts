import type { CapturedMail } from "./smtp-sink";

/** Corps d'un mail capturé, quoted-printable décodé en UTF-8 (accents compris). */
export function mailBody(mail: CapturedMail): string {
  const joined = mail.raw.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined[i], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Sujet décodé (encoded-word =?UTF-8?Q?…?= ou =?UTF-8?B?…?= de nodemailer). */
export function mailSubject(mail: CapturedMail): string {
  const m = /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(mail.raw);
  if (!m) return "";
  return m[1]
    .replace(/\r\n[ \t]/g, " ")
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=\s*/gi, (_, enc: string, text: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(
            text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          ).toString("utf8"),
    )
    .trim();
}
