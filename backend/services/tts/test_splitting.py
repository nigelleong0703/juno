import unittest

from splitting import detect_lang, language_runs, split_parts


class SplittingTest(unittest.TestCase):
    def test_detects_language_by_script(self):
        self.assertEqual(detect_lang("Sure, see you at nine."), "en")
        self.assertEqual(detect_lang("好的，明天九点。"), "zh")
        self.assertEqual(detect_lang("Meet at 吉隆坡 station"), "zh")

    def test_mixed_text_splits_into_runs_keeping_neutral_characters(self):
        self.assertEqual(
            language_runs("明天去 Kuala Lumpur 开会，3点。"),
            [("zh", "明天去 "), ("en", "Kuala Lumpur "), ("zh", "开会，3点。")],
        )
        self.assertEqual(language_runs("42 apples"), [("en", "42 apples")])
        self.assertEqual(language_runs("   "), [])

    def test_first_sentence_is_its_own_part_and_the_rest_are_packed(self):
        text = "Sure, here is the plan for tomorrow. Meeting at nine. Lunch by the river. Parcel at three."
        parts = split_parts(text)
        self.assertEqual(parts[0], "Sure, here is the plan for tomorrow.")
        self.assertEqual(parts[1], "Meeting at nine. Lunch by the river. Parcel at three.")
        self.assertEqual(len(parts), 2)

    def test_tiny_opening_sentence_merges_forward(self):
        self.assertEqual(split_parts("Sure. Meeting at nine, lunch at noon."), ["Sure. Meeting at nine, lunch at noon."])

    def test_chinese_sentences_split_without_spaces(self):
        parts = split_parts("好的，明天的安排是这样。早上九点开会！中午我帮你订了餐厅。")
        self.assertEqual(parts, ["好的，明天的安排是这样。", "早上九点开会！中午我帮你订了餐厅。"])
        self.assertEqual("".join(parts), "好的，明天的安排是这样。早上九点开会！中午我帮你订了餐厅。")

    def test_decimals_and_abbreviation_free_text_stay_whole(self):
        self.assertEqual(split_parts("It costs 3.50 dollars today"), ["It costs 3.50 dollars today"])


if __name__ == "__main__":
    unittest.main()
