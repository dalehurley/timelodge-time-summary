# TimeLodge Time Summary

Get the recorded and billable time for a date in your TimeLodge workspace. Use the totals in a delivery report or in another step of your GitHub Actions workflow.

1. In TimeLodge, create a service token for your workspace with the `time:read` scope.
2. Add it to your GitHub repository or environment secrets as `TIMELODGE_API_TOKEN`.
3. Add the action to a workflow you trust. For production workflows, pin the action to a reviewed commit SHA.

```yaml
- name: Read the daily TimeLodge totals
  id: timelodge
  uses: dalehurley/timelodge-time-summary@v0.1.0
  with:
      api-token: ${{ secrets.TIMELODGE_API_TOKEN }}
      date: '2026-11-18'
```

| Output             | Meaning                                                      |
| ------------------ | ------------------------------------------------------------ |
| `entry-count`      | Number of time entries on the requested TimeLodge entry date |
| `recorded-seconds` | Sum of the stored durations of those entries                 |
| `billable-seconds` | Sum of the stored durations for entries marked billable      |

The action reads up to 10,000 entries and writes numeric outputs. It uses stored durations, so live timer elapsed time is outside the report. Control which repositories and downstream steps may see the totals. Access requires a TimeLodge workspace with API access. GitHub runner usage follows your repository’s GitHub plan. To disconnect, remove the secret and revoke its service token in TimeLodge.

Start with a manually triggered workflow in a private repository and a date you can check against TimeLodge.
