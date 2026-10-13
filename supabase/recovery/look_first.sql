-- READ-ONLY. Lists what changed between two times, from the safety log (RECOVERY.md §5).
-- Replace PASTE_FROM_TIME and PASTE_TO_TIME with times in UTC, e.g. 2026-11-02 14:00:00+00
select table_name, op, count(*) as changes, min(at) as first_change, max(at) as last_change
from public.safety_log
where at >= timestamptz 'PASTE_FROM_TIME' and at < timestamptz 'PASTE_TO_TIME'
group by table_name, op
order by table_name, op;
