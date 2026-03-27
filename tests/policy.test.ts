import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

describe("policy", () => {
  it("serves the privacy policy without API auth", async () => {
    process.env.GATEWAY_API_KEY = "super-secret";
    const { app } = createApp();

    const res = await request(app).get("/policy");

    expect(res.status).toBe(200);
    expect(res.type).toContain("html");
    expect(res.text).toContain("Privacy Policy");
    expect(res.text).toContain("api.jimmothy.site");
  });
});
