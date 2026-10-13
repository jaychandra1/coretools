output "project_number" {
  description = "Number of the production project (liens and some console URLs use it)."
  value       = data.google_project.prod.number
}

output "lien" {
  description = "Lien that blocks deletion of the production project (`gcloud alpha resource-manager liens list --project <id>` shows it)."
  value       = google_resource_manager_lien.prevent_project_deletion.name
}

output "alert_policies" {
  description = "Alert policy resource names (empty when enable_alerting = false)."
  value = concat(
    google_monitoring_alert_policy.drive_5xx[*].name,
    google_monitoring_alert_policy.drive_throttled[*].name,
    google_monitoring_alert_policy.drive_quota_usage[*].name,
    google_monitoring_alert_policy.drive_quota_exceeded[*].name,
  )
}

output "dev_project_id" {
  description = "Development project id, or null when create_dev_project = false."
  value       = one(google_project.dev[*].project_id)
}
