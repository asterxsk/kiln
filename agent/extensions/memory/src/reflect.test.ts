import assert from "node:assert/strict";
import { test } from "node:test";
import {
	REFLECT_CUSTOM_TYPE,
	REFLECT_INSTRUCTION,
	reflectionDraft,
	shouldReflect,
	type ReflectState,
} from "./reflect.ts";

function state(overrides: Partial<ReflectState> = {}): ReflectState {
	return { enabled: true, done: false, outcome: "completed", worked: true, usedMemory: false, ...overrides };
}

test("reflects on a clean, productive turn", () => {
	assert.equal(shouldReflect(state()), true);
});

test("does not reflect on a pure Q&A turn that did no work", () => {
	assert.equal(shouldReflect(state({ worked: false })), false);
});

test("does not reflect when disabled or already done this turn", () => {
	assert.equal(shouldReflect(state({ enabled: false })), false);
	assert.equal(shouldReflect(state({ done: true })), false);
});

test("does not reflect when the run did not settle cleanly", () => {
	assert.equal(shouldReflect(state({ outcome: "aborted" })), false);
	assert.equal(shouldReflect(state({ outcome: "error" })), false);
});

test("does not reflect when the agent already wrote memory", () => {
	assert.equal(shouldReflect(state({ usedMemory: true })), false);
});

test("the reflection draft is a hidden custom message carrying the instruction", () => {
	assert.deepEqual(reflectionDraft(), {
		type: "custom_message",
		customType: REFLECT_CUSTOM_TYPE,
		content: REFLECT_INSTRUCTION,
		display: false,
	});
});
