import pytest

from app.director import extract_json_object


def test_extract_director_json_accepts_fenced_prose_and_trailing_comma():
    raw = '''
    完成，以下是生产数据：
    ```json
    {
      "logline": "追查玉佩",
      "scenes": [{"index": 1, "location": "仓库",}],
      "shots": [{"scene_index": 1, "title": "入场",}],
    }
    ```
    '''
    parsed = extract_json_object(raw)
    assert parsed["logline"] == "追查玉佩"
    assert parsed["shots"][0]["title"] == "入场"


def test_extract_director_json_repairs_missing_colon():
    parsed = extract_json_object('{"logline" "追查玉佩", "scenes": [], "shots": []}')
    assert parsed["logline"] == "追查玉佩"


def test_extract_director_json_normalizes_full_width_token_punctuation():
    parsed = extract_json_object('{"logline"："追查玉佩"，"scenes"：[]，"shots"：[]}')
    assert parsed == {"logline": "追查玉佩", "scenes": [], "shots": []}


def test_extract_director_json_rejects_non_json_text():
    with pytest.raises(ValueError, match="没有返回 JSON 对象"):
        extract_json_object("我无法完成这个任务")
