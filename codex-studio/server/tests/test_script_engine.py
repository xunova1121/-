from app.script_engine import ParsedScene, extract_characters, parse_scenes, scene_to_shots


def test_markdown_timecoded_outline_becomes_readable_shots():
    script = """
    # 场景 1 沙丘 - 黎明
    **（0:00-0:12）** **画面：** 黎明前的沙丘安静无声
    **细节：** 旅人裹着长袍
    **动作：** 旅人缓慢抬头
    ---
    **（0:13-0:25）** **画面：** 风声骤停
    **细节：** 旅人手指收紧
    """
    scenes = parse_scenes(script)
    shots = scene_to_shots(scenes[0], 1)
    assert len(shots) == 2
    assert shots[0]["number"] == "001"
    assert shots[0]["description"] == "黎明前的沙丘安静无声；旅人裹着长袍；旅人缓慢抬头"
    assert shots[1]["description"] == "风声骤停；旅人手指收紧"
    assert all("**" not in shot["description"] and "0:00" not in shot["description"] for shot in shots)


def test_production_labels_are_not_misidentified_as_characters():
    text = "**画面：** 雪原无声\n**细节：** 风吹衣角\n李狗蛋：谁在那里？\n旁白：夜色更深"
    assert extract_characters(text) == ["李狗蛋"]


def test_plain_script_keeps_one_action_or_dialogue_per_shot():
    scene = ParsedScene(1, "场景 1", "院子", "白天", "李狗蛋抡起斧头\n李狗蛋：谁在那里？", "")
    shots = scene_to_shots(scene, 1)
    assert len(shots) == 2
    assert shots[0]["action"] == "李狗蛋抡起斧头"
    assert shots[1]["dialogue"] == "谁在那里？"
