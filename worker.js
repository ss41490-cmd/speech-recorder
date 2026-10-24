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
  "Access-Control-Allow-Headers": "Content-Type, X-Recorder-Secret, X-Page-Id, X-File-Name, X-Caption, X-Action, X-Block-Id, X-Match",
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

    if (request.headers.get("X-Action") === "delete") return removeAudio(request, env, pageId);

    const contentType = (request.headers.get("Content-Type") || "").split(";")[0];
    if (!["audio/mp4", "audio/wav", "audio/mpeg"].includes(contentType))
      return reply(415, { error: "지원하지 않는 오디오 형식: " + contentType });

    const body = await request.arrayBuffer();
    if (!body.byteLength) return reply(400, { error: "빈 파일입니다." });
    if (body.byteLength > MAX_BYTES) return reply(413, { error: "5MB를 넘는 녹음은 올릴 수 없습니다." });

    try {
      if (!(await isAllowedPage(env, pageId))) return reply(403, { error: "허용되지 않은 페이지입니다." });

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
      const added = await notion(env, "blocks/" + pageId + "/children", {
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

      const block = (added.results || []).find(b => b.type === "audio");
      return reply(200, { ok: true, blockId: block ? block.id : "" });
    } catch (e) {
      return reply(502, { error: String(e.message || e) });
    }
  },
};

// 스피치 데이터베이스의 행인지 확인
async function isAllowedPage(env, pageId) {
  const page = await notion(env, "pages/" + pageId);
  return (page.parent && page.parent.database_id || "").replace(/-/g, "") === ALLOWED_DATABASE;
}

// 페이지에 붙은 녹음(오디오 블록)을 노션 휴지통으로 보낸다.
// X-Block-Id가 있으면 그 블록, 없으면 캡션에 X-Match(녹음 시각)가 들어간 오디오 블록.
async function removeAudio(request, env, pageId) {
  try {
    if (!(await isAllowedPage(env, pageId))) return reply(403, { error: "허용되지 않은 페이지입니다." });

    const blockId = (request.headers.get("X-Block-Id") || "").replace(/-/g, "");
    const match = decodeURIComponent(request.headers.get("X-Match") || "");
    let target = "";

    if (/^[0-9a-f]{32}$/.test(blockId)) {
      const block = await notion(env, "blocks/" + blockId);
      if (block.archived || block.in_trash) return reply(200, { ok: true, already: true });
      if (block.type !== "audio" || (block.parent && block.parent.page_id || "").replace(/-/g, "") !== pageId)
        return reply(403, { error: "이 페이지의 녹음이 아닙니다." });
      target = blockId;
    } else if (match) {
      let cursor;
      do {
        const list = await notion(env, "blocks/" + pageId + "/children?page_size=100" + (cursor ? "&start_cursor=" + cursor : ""));
        const hit = list.results.find(b => b.type === "audio" &&
          (b.audio.caption || []).map(c => c.plain_text).join("").includes(match));
        if (hit) { target = hit.id; break; }
        cursor = list.has_more ? list.next_cursor : null;
      } while (cursor);
      if (!target) return reply(200, { ok: true, already: true });
    } else {
      return reply(400, { error: "삭제할 녹음을 찾을 정보가 없습니다." });
    }

    await notion(env, "blocks/" + target, { method: "DELETE" });
    return reply(200, { ok: true });
  } catch (e) {
    return reply(502, { error: String(e.message || e) });
  }
}
