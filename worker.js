// Cloudflare Worker: 녹음기에서 받은 오디오를 노션 페이지 '내 녹음' 아래(페이지 맨 끝)에 붙인다.
// 필요한 Secret (Cloudflare 대시보드 > Worker > 설정 > 변수 및 비밀):
//   NOTION_TOKEN     노션 내부 통합 시크릿
//   RECORDER_SECRET  녹음기와 서버가 함께 쓰는 비밀 문구(직접 정한 값)

const ALLOWED_ORIGIN = "https://ss41490-cmd.github.io";
// 스피치 페이지의 '원고·음성가이드' 데이터베이스 행에만 올릴 수 있게 제한
const ALLOWED_DATABASE = "22eeea3bc0bd4a91a19b1e5282c8ab81";
const NOTION_VERSION = "2022-06-28";
const MAX_BYTES = 5 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Recorder-Secret, X-Page-Id, X-File-Name, X-Caption",
  "Access-Control-Max-Age": "86400",
};

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function notion(env, path, init = {}) {
  const res = await fetch("https://api.notion.com/v1/" + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": NOTION_VERSION,
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.code || res.status) + ": " + (data.message || "notion error"));
  return data;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return reply(405, { error: "POST only" });

    if (!env.RECORDER_SECRET || request.headers.get("X-Recorder-Secret") !== env.RECORDER_SECRET)
      return reply(401, { error: "비밀 문구가 맞지 않습니다." });

    const pageId = (request.headers.get("X-Page-Id") || "").replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/.test(pageId)) return reply(400, { error: "페이지 ID가 올바르지 않습니다." });

    const contentType = (request.headers.get("Content-Type") || "").split(";")[0];
    if (!["audio/mp4", "audio/wav", "audio/mpeg"].includes(contentType))
      return reply(415, { error: "지원하지 않는 오디오 형식: " + contentType });

    const body = await request.arrayBuffer();
    if (!body.byteLength) return reply(400, { error: "빈 파일입니다." });
    if (body.byteLength > MAX_BYTES) return reply(413, { error: "5MB를 넘는 녹음은 올릴 수 없습니다." });

    try {
      // 대상 페이지가 스피치 데이터베이스의 행인지 확인
      const page = await notion(env, "pages/" + pageId);
      const parentDb = (page.parent && page.parent.database_id || "").replace(/-/g, "");
      if (parentDb !== ALLOWED_DATABASE) return reply(403, { error: "허용되지 않은 페이지입니다." });

      const ext = contentType === "audio/mp4" ? "m4a" : contentType === "audio/wav" ? "wav" : "mp3";
      const rawName = decodeURIComponent(request.headers.get("X-File-Name") || "") || "내녹음";
      const filename = rawName.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) + "." + ext;

      const upload = await notion(env, "file_uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "single_part", filename, content_type: contentType }),
      });

      const form = new FormData();
      form.append("file", new Blob([body], { type: contentType }), filename);
      await notion(env, "file_uploads/" + upload.id + "/send", { method: "POST", body: form });

      const caption = decodeURIComponent(request.headers.get("X-Caption") || "").slice(0, 200);
      await notion(env, "blocks/" + pageId + "/children", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          children: [{
            type: "audio",
            audio: {
              type: "file_upload",
              file_upload: { id: upload.id },
              caption: caption ? [{ type: "text", text: { content: caption } }] : [],
            },
          }],
        }),
      });

      return reply(200, { ok: true });
    } catch (e) {
      return reply(502, { error: String(e.message || e) });
    }
  },
};
