import json
from types import SimpleNamespace

import httpx
import pytest

from decision import DecisionError, LlmBackend, TypeSafeBackend, make_text_fn

BODY = {
    "model": "systemone",
    "state": {"url": "https://example.com", "elements": [{"i": 1, "tag": "a"}]},
    "questions": {
        "operation": {
            "type": "choice",
            "criteria": {"CLICK": "c", "TYPE_TEXT": "t", "DONE": "d", "BLOCKED": "b"},
            "instructions": {"goal": "Book a flight", "rules": ["be quick"]},
        },
        "click_target": {"type": "choice", "criteria": {"1": "link", 9: "button"}, "instructions": "pick click"},
        "type_text_target": {"type": "choice", "criteria": {"2": "a", "3": "b", "4": "c"}, "instructions": "pick field"},
    },
}

CONTEXT = {"goal": 'Fly to "ZRH"', "field": "Destination", "value": "", "page_text": "", "recent_actions": []}


class FakeLlm:
    def __init__(self, parsed, *, as_text=False):
        self.parsed, self.as_text, self.calls = parsed, as_text, []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        props = kwargs["json_schema"]["properties"]
        for key, value in (self.parsed or {}).items():
            if "enum" in props.get(key, {}) and value not in props[key]["enum"]:
                raise ValueError("Plugin LLM structured output did not match schema")
        if self.as_text:
            return SimpleNamespace(parsed=None, text=json.dumps(self.parsed))
        return SimpleNamespace(parsed=self.parsed, text=json.dumps(self.parsed))


def test_llm_backend_converts_choice_to_jev_answers():
    answers = LlmBackend(FakeLlm({"operation": "TYPE_TEXT", "type_text_target": "3"})).decide(BODY)["answers"]
    assert answers["operation"]["choice"] == "TYPE_TEXT" and answers["operation"]["confidence"] == 1.0
    assert answers["type_text_target"]["probabilities"] == {"2": 0.0, "3": 1.0, "4": 0.0}


def test_llm_backend_parses_text_when_parsed_missing():
    llm = FakeLlm({"operation": "CLICK", "click_target": "9"}, as_text=True)
    answers = LlmBackend(llm).decide(BODY)["answers"]
    assert answers["click_target"]["probabilities"] == {"1": 0.0, "9": 1.0}


def test_llm_backend_rejects_unparseable_response():
    llm = FakeLlm(None)
    llm.complete_structured = lambda **kw: SimpleNamespace(parsed=None, text="not json")
    with pytest.raises(DecisionError):
        LlmBackend(llm).decide(BODY)


def test_llm_backend_rejects_target_not_offered():
    with pytest.raises(DecisionError):
        LlmBackend(FakeLlm({"operation": "CLICK", "click_target": "99"})).decide(BODY)


def test_llm_backend_requires_target_for_chosen_operation():
    with pytest.raises(DecisionError):
        LlmBackend(FakeLlm({"operation": "CLICK"})).decide(BODY)


def test_llm_backend_schema_enums_match_criteria():
    llm = FakeLlm({"operation": "DONE"})
    LlmBackend(llm).decide(BODY)
    props = llm.calls[0]["json_schema"]["properties"]
    assert props["operation"]["enum"] == list(BODY["questions"]["operation"]["criteria"])
    assert props["type_text_target"]["enum"] == ["2", "3", "4"]
    assert props["click_target"]["enum"] == ["1", "9"]
    assert llm.calls[0]["task"] == "jev_browser_decide"


def test_text_fn_returns_plain_string_even_when_goal_has_quotes():
    text, meta = make_text_fn(FakeLlm({"text": 'Zurich "ZRH"'}, as_text=True))(CONTEXT)
    assert text == 'Zurich "ZRH"' and "latency_ms" in meta


def test_llm_backend_own_enum_check_rejects_unvalidated_target():
    llm = FakeLlm(None)
    llm.complete_structured = lambda **kw: SimpleNamespace(parsed={"operation": "CLICK", "click_target": "99"}, text="")
    with pytest.raises(DecisionError):
        LlmBackend(llm).decide(BODY)


@pytest.mark.parametrize("value", ["", "   ", "x" * 2001])
def test_text_fn_rejects_empty_or_oversized_text(value):
    with pytest.raises(DecisionError):
        make_text_fn(FakeLlm({"text": value}))(CONTEXT)


def test_typesafe_backend_maps_http_error_to_decision_error():
    transport = httpx.MockTransport(lambda request: httpx.Response(401, json={"error": "bad key"}))
    backend = TypeSafeBackend("k", "m", transport=transport)
    with pytest.raises(DecisionError):
        backend.decide(BODY)
    backend.close()


def test_typesafe_backend_posts_body_and_bearer():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"model": "m", "answers": {}})

    out = TypeSafeBackend("k", "m", transport=httpx.MockTransport(handler)).decide(BODY)
    assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
    assert seen["auth"] == "Bearer k"
    assert seen["body"] == json.loads(json.dumps(BODY))
    assert out == {"model": "m", "answers": {}}
