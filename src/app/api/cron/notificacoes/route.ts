import { NextRequest } from "next/server";

const EDGE_FUNCTION_URL =
  "https://nheyevdjomfphlzmsszk.supabase.co/functions/v1/notificacoes-email";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const res = await fetch(EDGE_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": cronSecret ?? "",
    },
  });

  const data = await res.json();
  return Response.json(data, { status: res.status });
}
