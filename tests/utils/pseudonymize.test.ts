/**
 * On-device pseudonymization of the answer check's cloud confirmation: every
 * identifier the rules find is replaced by a stable token in all three parts,
 * quantities stay, and text the rules cannot read is marked not sendable.
 */
import { describe, it, expect } from "vitest";
import { pseudonymizeForCheck } from "../../src/utils/pseudonymize.js";

const one = (text: string) => pseudonymizeForCheck([{ role: "user", content: text }], "", "");
const out = (text: string) => one(text).messages[0].content;

describe("identifiers are replaced", () => {
    it("contact and record numbers: email, URL, phone (national and international), SSN, labelled and long numbers, codes", () => {
        for (const [text, gone] of [
            ["Email maria.lopez@example.com today", "maria.lopez@example.com"],
            ["See https://clinic.example.com/p/123 now", "clinic.example.com"],
            ["Call 555-123-4567 please", "555-123-4567"],
            ["Fax (212) 555-0199 please", "555-0199"],
            // a local number, seven digits as 3-4 (it went out as-is before)
            ["My callback number is 555-0142, can you note that down?", "555-0142"],
            ["Text me at 555.0142 tonight", "555.0142"],
            ["Call +44 20 7946 0958 please", "7946 0958"],
            ["Her SSN 123-45-6789 is on file", "123-45-6789"],
            ["Her MRN is 00123456 and it is on file", "00123456"],
            ["Client ID: AB-99812 was updated", "99812"],
            ["Case #7781-22 was closed", "7781-22"],
            ["Member number XK42LP9 is active", "XK42LP9"],
        ] as const) {
            expect(out(text), text).not.toContain(gone);
            expect(out(text), text).toMatch(/\b(?:EMAIL|URL|PHONE|SSN|ID)_1\b/);
        }
    });
    it("dates: numeric, ISO, with a month name, month and year", () => {
        for (const text of ["DOB 03/14/1988 on file", "Seen on 2026-09-20 again", "Born 14 March 1988 in town", "Due March 14, 2026 at noon", "Seen in March 2024 last"]) {
            expect(out(text), text).toMatch(/DATE_1/);
            expect(out(text), text).not.toMatch(/14|2026-09|March/);
        }
    });
    it("addresses: a street with its number, a state with its ZIP", () => {
        expect(out("Lives at 42 Oak Street, Springfield IL 62704.")).toBe("Lives at ADDRESS_1, NAME_1 ADDRESS_2.");
    });
    it("names: mid-sentence, after an honorific (either case), at a sentence start, accented, O'Brien and McDonald, possessive, all caps", () => {
        expect(out("Then I met Maria Lopez.")).toBe("Then I met NAME_1 NAME_2.");
        expect(out("Seen by Dr. Chen and dr. park today.")).toBe("Seen by Dr. NAME_1 and dr. NAME_2 today.");
        expect(out("Maria has a fever since Tuesday.")).toBe("NAME_1 has a fever since Tuesday.");
        expect(out("Called José García about it.")).toBe("Called NAME_1 NAME_2 about it.");
        expect(out("O'Brien took 40 units. McDonald refused.")).toBe("NAME_1 took 40 units. NAME_2 refused.");
        expect(out("The patient, Liam, is 7; Liam’s sister Emma attends too.")).toBe("The patient, NAME_1, is 7; NAME_1’s sister NAME_2 attends too.");
        expect(out("Patient: LOPEZ, MARIA.")).toBe("Patient: NAME_1, NAME_2.");
        // after an abbreviation the next word does not start a sentence
        expect(out("Seen at St. Mary Hospital.")).toBe("Seen at St. NAME_1 NAME_2.");
    });
});

describe("the same identifier is the same token everywhere; different ones differ", () => {
    it("a local number keeps its identity: the same number is the same token, a different one is not", () => {
        const same = pseudonymizeForCheck([{ role: "user", content: "My callback number is 555-0142." }], "What's the callback number?", "Your callback number is 555-0142.");
        expect(same.messages[0].content).toBe("My callback number is PHONE_1.");
        expect(same.answer).toBe("Your callback number is PHONE_1.");
        const other = pseudonymizeForCheck([{ role: "user", content: "My callback number is 555-0142." }], "What's the callback number?", "I have it: 575-0142.");
        expect(other.messages[0].content).toBe("My callback number is PHONE_1.");
        expect(other.answer).toBe("I have it: PHONE_2.");
    });
    it("across turns, the request and the answer, whatever the case", () => {
        const r = pseudonymizeForCheck(
            [{ role: "user", content: "Book it for Maria Lopez on 03/14/2026." }, { role: "assistant", content: "Booked for Maria." }],
            "What name was it under, and what about maria's sister Ana?",
            "It is under MARIA Lopez, on 03/14/2026.",
        );
        expect(r.messages.map(m => m.content)).toEqual(["Book it for NAME_1 NAME_2 on DATE_1.", "Booked for NAME_1."]);
        expect(r.prompt).toBe("What name was it under, and what about NAME_1's sister NAME_3?");
        expect(r.answer).toBe("It is under NAME_1 NAME_2, on DATE_1.");
        expect(r.replaced).toBe(4);
        expect(r.sendable).toBe(true);
    });
    it("a wrong name in the answer stays a different token, so the check can still fail it", () => {
        const r = pseudonymizeForCheck([{ role: "user", content: "The client is Maria." }], "Who is the client?", "The client is Elena.");
        expect(r.messages[0].content).not.toBe(r.answer);
        expect(r.messages[0].content.match(/NAME_\d/)![0]).not.toBe(r.answer.match(/NAME_\d/)![0]);
    });
    it("a '$' in the text survives replacement untouched", () => {
        expect(out("Pay $1,240 to Maria by 03/14/2026 ($& fee).")).toBe("Pay $1,240 to NAME_1 by DATE_1 ($& fee).");
    });
});

describe("what is not an identifier stays, so the check can still read the conversation", () => {
    it("quantities, amounts, doses, units, arithmetic, years and common acronyms", () => {
        for (const text of [
            "We have 240 units of syrup in stock. Updated to 175 units remaining. After selling 40 more, 135 left.",
            "$1,240 - $385 = $855, and 6.5 + 7 = 13.5 hours.",
            "Take 2 tablets each way. A 6.5-hour shift, 40-unit pack, B12 and 3rd dose, 100mg PRN BID.",
            "It was 12.50 each in 2024, OK?",
            "The scores were 240 65 40, then 12 15 18.",
        ]) expect(out(text), text).toBe(text);
    });
    it("seven digits split by a space are not a phone number (quantities stay)", () => {
        expect(out("We sold 240 1200-unit packs.")).toBe("We sold 240 1200-unit packs.");
    });
    it("a word the text also writes in lowercase is not a name at a sentence start", () => {
        expect(out("Cancel the booking. Please cancel it now.")).toBe("Cancel the booking. Please cancel it now.");
    });
});

describe("what the rules cannot read is not sent", () => {
    it("a script other than Latin marks the copy not sendable, wherever it appears", () => {
        expect(one("Patient: Ана Иванова.").sendable).toBe(false);
        expect(pseudonymizeForCheck([{ role: "user", content: "fine" }], "ok", "患者は田中さんです").sendable).toBe(false);
        expect(pseudonymizeForCheck([{ role: "user", content: "fine" }], "ok", "José is here").sendable).toBe(true);
    });
    it("known misses are documented, not hidden: a name never capitalized passes through", () => {
        // If this starts passing, update the file header and this test.
        expect(out("maria lopez called.")).toContain("maria");
    });
});
