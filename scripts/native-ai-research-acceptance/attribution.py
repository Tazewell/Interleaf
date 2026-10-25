"""Assertions for the deterministic comparison fixture, not semantic judging."""
import re


def assert_attribution(report, sources, expected):
    assert all(sources[x]['availability'] == 'valid' for x in report['sourceIds'])
    assert_claim_bindings(report, sources, expected)


def assert_claim_bindings(report, sources, expected):
    """Check attribution only; historical stale sources must remain stale."""
    used = set()
    for item in expected:
        # The controlled composer emits one paper/fact per paragraph. A global
        # valid-source list cannot establish which claim a citation belongs to.
        paragraphs = [p for p in report['content'].split('\n\n') if item['claim'] in p]
        assert paragraphs, ('attribution: missing claim', item)
        for paragraph in paragraphs:
            ids = re.findall(r'\[([^\]\n]+)\]', paragraph)
            assert ids, ('attribution: missing inline citation', paragraph)
            bound = False
            for sid in ids:
                assert sid in report['sourceIds'], ('attribution: unlisted source', sid)
                ev = sources[sid]
                assert ev['paperId'] == item['paperId'] and ev['documentId'] == item['documentId'], ('attribution: wrong original', item, ev)
                if item['claim'] in ev['excerpt']:
                    bound = True
                    used.add(sid)
            assert bound, ('attribution: original does not contain claim', item)
    assert len(used) >= len(expected), 'attribution: different papers share evidence identity'
