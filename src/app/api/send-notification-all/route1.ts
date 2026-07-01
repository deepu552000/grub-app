import { NextRequest, NextResponse } from "next/server";
import { sendNotificationToAll } from "@/lib/send-notification";

const APP_FID = 9152;
const APP_URL = "https://grub-app-eight.vercel.app";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-internal-secret");

  if (secret !== process.env.NOTIFICATION_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { title, body, targetUrl } = await request.json();

  if (!title || !body) {
    return NextResponse.json(
      { error: "title and body are required" },
      { status: 400 }
    );
  }

  const result = await sendNotificationToAll(APP_FID, {
    notificationId: `grub-broadcast-${Date.now()}`,
    title: title.slice(0, 32),
    body: body.slice(0, 128),
    targetUrl: targetUrl ?? APP_URL,
  });

  return NextResponse.json(result);
}