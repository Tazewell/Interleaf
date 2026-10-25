import copy
import unittest

from attribution import assert_attribution


class AttributionTest(unittest.TestCase):
    def setUp(self):
        self.expected = [
            {'paperId': 'paper-a', 'documentId': 'doc-a', 'claim': 'A improves error from 8 to 4.'},
            {'paperId': 'paper-b', 'documentId': 'doc-b', 'claim': 'B worsens error from 4 to 8.'},
        ]
        self.sources = {
            str(i): dict(item, id=str(i), excerpt=item['claim'], availability='valid')
            for i, item in enumerate(self.expected)
        }
        self.report = {'content': '\n\n'.join(x['claim'] + f' [{i}]' for i, x in enumerate(self.expected)), 'sourceIds': ['0', '1']}

    def test_correct(self):
        assert_attribution(self.report, self.sources, self.expected)

    def test_swapped_but_valid_sources(self):
        report = copy.deepcopy(self.report)
        report['content'] = self.expected[0]['claim'] + ' [1]\n\n' + self.expected[1]['claim'] + ' [0]'
        with self.assertRaisesRegex(AssertionError, 'attribution'):
            assert_attribution(report, self.sources, self.expected)

    def test_missing_inline_binding(self):
        report = copy.deepcopy(self.report)
        report['content'] = '\n\n'.join(x['claim'] for x in self.expected)
        with self.assertRaisesRegex(AssertionError, 'attribution'):
            assert_attribution(report, self.sources, self.expected)


if __name__ == '__main__':
    unittest.main()
