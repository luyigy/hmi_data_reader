"""One focused check of the frozen five-dimensional scoring contract."""
import pytest

from scripts.score_relations import score_relations


def test_relation_scoring():
    base = dict(category='温度', parameter='料筒温度', value=200,
                unit='℃', role='setpoint', label='第2区', status='verified')
    truth = [base]
    equal = score_relations(truth, [{**base, 'value': '200.00'}])['温度']
    assert (equal['tp'], equal['fp'], equal['fn']) == (1, 0, 0)
    for key, wrong in [('parameter', '模温'), ('value', 201), ('unit', 'F'),
                       ('role', 'actual'), ('label', '第3区'), ('value', None)]:
        result = score_relations(truth, [{**base, key: wrong}])['温度']
        assert (result['tp'], result['fp'], result['fn']) == (0, 1, 1)
        assert len(result['missing']) == len(result['unexpected']) == 1
    assert score_relations(truth, [base, base])['温度']['fp'] == 1
    failed = score_relations(truth, [])['温度']
    assert failed['fn'] == 1 and failed['recall'] == 0 and failed['precision'] is None
    assert score_relations([], []) == {}
    unknown = score_relations([{**base, 'status': 'unresolved'}], [])['温度']
    assert unknown['unresolved_truth'] == 1 and unknown['recall'] is None
    for bad in [True, 'NaN', 'Infinity', 'bad']:
        with pytest.raises(ValueError):
            score_relations(truth, [{**base, 'value': bad}])
    with pytest.raises(ValueError):
        score_relations([{**base, 'status': None}], [])
