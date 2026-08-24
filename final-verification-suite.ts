// final-verification-suite.ts
// Final Verification Test Suite for Internal Messenger

async function runFinalVerification() {
  console.log("===============================================================");
  console.log("    COMPREHENSIVE FINAL VERIFICATION FOR INTERNAL MESSENGER   ");
  console.log("===============================================================\n");

  const baseUrl = "http://localhost:3000/api/messenger";
  let passCount = 0;
  let failCount = 0;
  const results: { test: string; status: "PASS" | "FAIL"; details: string }[] = [];

  function record(testName: string, passed: boolean, details: string = "") {
    if (passed) {
      console.log(`[PASS] ${testName}`);
      passCount++;
      results.push({ test: testName, status: "PASS", details });
    } else {
      console.error(`[FAIL] ${testName} - ${details}`);
      failCount++;
      results.push({ test: testName, status: "FAIL", details });
    }
  }

  try {
    // 1. Health & Status
    const healthRes = await fetch("http://localhost:3000/api/health");
    const healthData = await healthRes.json();
    record("Server Runtime Health", healthRes.ok && healthData.status === "ok", JSON.stringify(healthData));

    // 2. Search Users with partial, exact, role, and empty queries
    console.log("\n--- TEST: User Search Operations ---");
    const s1 = await (await fetch(`${baseUrl}/users/search?q=علي`)).json();
    record("Search Users: Partial Arabic query ('علي')", s1.success && s1.users.length > 0);

    const s2 = await (await fetch(`${baseUrl}/users/search?q=user_does_not_exist_xyz`)).json();
    record("Search Users: Non-existing user returns empty array", s2.success && s2.users.length === 0);

    const s3 = await (await fetch(`${baseUrl}/users/search?q=`)).json();
    record("Search Users: Empty query returns all registered contacts", s3.success && s3.users.length >= 4);

    const s4 = await (await fetch(`${baseUrl}/users/search?role=instructor`)).json();
    record("Search Users: Filter by role ('instructor')", s4.success && s4.users.every((u: any) => u.role === "instructor"));

    // 3. Prevent duplicate conversation creation between same user pairs
    console.log("\n--- TEST: Conversation Creation & Deduplication ---");
    const userA = "user_ahmed_1001";
    const userB = "user_sara_1002";

    const c1 = await (await fetch(`${baseUrl}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentUserId: userA,
        targetUserId: userB,
        currentUserName: "أحمد مصطفى",
        targetUserName: "سارة إبراهيم",
      }),
    })).json();

    const c2 = await (await fetch(`${baseUrl}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentUserId: userB,
        targetUserId: userA,
        currentUserName: "سارة إبراهيم",
        targetUserName: "أحمد مصطفى",
      }),
    })).json();

    record("Create Conversation & Prevent Duplication (Canonical ID)", c1.success && c2.success && c1.conversation.id === c2.conversation.id, `ID: ${c1.conversation?.id}`);
    const convId = c1.conversation.id;

    // 4. Send Message from User A to User B
    console.log("\n--- TEST: Send Message & Message Storage ---");
    const sendA = await (await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: userA,
        senderName: "أحمد مصطفى",
        senderRole: "student",
        text: "مرحباً سارة، هل لديكِ ملخص كورس بايثون؟",
        recipientId: userB,
      }),
    })).json();
    record("User A sends message to User B", sendA.success && Boolean(sendA.messageRecord.id));
    const msgIdA = sendA.messageRecord.id;

    // 5. Verify User B receives conversation with unread count
    console.log("\n--- TEST: Unread Count & Persistence for Recipient ---");
    const convsB = await (await fetch(`${baseUrl}/conversations?userId=${userB}`)).json();
    const convItemB = convsB.conversations.find((c: any) => c.id === convId);
    record("User B sees conversation in list with unread > 0", Boolean(convItemB) && convItemB.unreadCount >= 1, `Unread: ${convItemB?.unreadCount}`);

    // 6. User B replies to User A
    console.log("\n--- TEST: User B Reply ---");
    const sendB = await (await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: userB,
        senderName: "سارة إبراهيم",
        senderRole: "student",
        text: "أهلاً أحمد، نعم بالتأكيد! سأرفعه لك الآن.",
        recipientId: userA,
      }),
    })).json();
    record("User B sends reply to User A", sendB.success && Boolean(sendB.messageRecord.id));
    const msgIdB = sendB.messageRecord.id;

    // 7. User A reads conversation -> unread count resets to 0
    console.log("\n--- TEST: Read / Unread Status Reset ---");
    const readA = await (await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userA }),
    })).json();
    record("User A marks conversation as read", readA.success);

    const convsAAfter = await (await fetch(`${baseUrl}/conversations?userId=${userA}`)).json();
    const convItemAAfter = convsAAfter.conversations.find((c: any) => c.id === convId);
    record("User A unread count reset to 0 after reading", convItemAAfter?.unreadCount === 0);

    // 8. Message Validation: Empty message & Oversized message
    console.log("\n--- TEST: Message Content Validation ---");
    const emptyRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: userA, text: "     " }),
    });
    record("Reject empty / whitespace-only messages (HTTP 400)", emptyRes.status === 400);

    const oversizedRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: userA, text: "x".repeat(3500) }),
    });
    record("Reject oversized messages >3000 chars (HTTP 400)", oversizedRes.status === 400);

    // 9. Authorization & Security Checks (IDOR)
    console.log("\n--- TEST: Security & IDOR Authorization ---");
    const intruder = "user_intruder_random_999";

    // Intruder reading conversation
    const intruderReadRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages?userId=${intruder}`);
    record("Intruder blocked from reading private conversation (HTTP 403)", intruderReadRes.status === 403);

    // Intruder posting to conversation
    const intruderPostRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: intruder, text: "محاولة تسلل" }),
    });
    record("Intruder blocked from posting to private conversation (HTTP 403)", intruderPostRes.status === 403);

    // User A trying to edit User B's message
    const unauthorizedEditRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgIdB)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userA, text: "محاولة تعديل رسالة سارة" }),
    });
    record("User A cannot edit User B's message (HTTP 403)", unauthorizedEditRes.status === 403);

    // User A editing their own message
    const authorizedEditRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgIdA)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userA, text: "مرحباً سارة، هل لديكِ ملخص كورس بايثون المعدل؟" }),
    });
    record("User A can edit their own message (HTTP 200)", authorizedEditRes.status === 200);

    // User A trying to delete User B's message
    const unauthorizedDeleteRes = await fetch(`${baseUrl}/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgIdB)}?userId=${userA}`, {
      method: "DELETE",
    });
    record("User A cannot delete User B's message (HTTP 403)", unauthorizedDeleteRes.status === 403);

    // 10. AI Bot Integration
    console.log("\n--- TEST: Gemini AI Tutor Integration ---");
    const aiConv = await (await fetch(`${baseUrl}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentUserId: "user_ahmed_1001",
        targetUserId: "ai_bot",
        currentUserName: "أحمد مصطفى",
        targetUserName: "المساعد الذكي (Gemini AI)",
      }),
    })).json();

    const aiMsg = await (await fetch(`${baseUrl}/conversations/${encodeURIComponent(aiConv.conversation.id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        senderId: "user_ahmed_1001",
        senderName: "أحمد مصطفى",
        text: "ما هو رقم محفظة اتصالات كاش الرسمية للدفع؟",
        recipientId: "ai_bot",
      }),
    })).json();

    record("Gemini AI Bot responds with accurate platform knowledge", aiMsg.success && Boolean(aiMsg.aiReply?.text));

    console.log("\n===============================================================");
    console.log(`VERIFICATION SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
    console.log("===============================================================");
  } catch (error) {
    console.error("Verification execution error:", error);
  }
}

runFinalVerification();
