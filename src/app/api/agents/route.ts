import { NextResponse } from "next/server";

const agents = [
  {
    id: "agent-core",
    name: "Core Orchestrator",
    status: "busy",
  },
  {
    id: "agent-reporter",
    name: "Insight Reporter",
    status: "idle",
  },
];

export async function GET() {
  return NextResponse.json({ data: agents });
}
