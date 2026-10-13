# Drive API alerting for the production project.
#
# Metrics (Google-provided, free to read):
#   serviceruntime.googleapis.com/api/request_count  DELTA, resource consumed_api
#     labels: service, method, response_code, response_code_class ("2xx"…"5xx")
#     sampled every 60 s, visible up to 30 min later
#   serviceruntime.googleapis.com/quota/rate/net_usage  DELTA, resource consumer_quota
#     labels: service, quota_metric, method
#   serviceruntime.googleapis.com/quota/limit  GAUGE, resource consumer_quota
#     labels: service, quota_metric, limit_name
#   serviceruntime.googleapis.com/quota/exceeded  GAUGE BOOL, resource consumer_quota
#
# Ratios are PromQL: filter-based conditions can't express usage ÷ limit,
# and Google's quota-alerting guide uses PromQL for it. The quota query
# follows that guide's single-service pattern.
#
# The app already retries 5xx/429 and rate-limit 403s with back-off
# (src/lib/core/authenticator/cloud-sync.ts), so these alerts are for
# sustained problems, not single failures.

locals {
  alerting = var.enable_alerting ? 1 : 0

  drive_requests = "\"serviceruntime.googleapis.com/api/request_count\", monitored_resource=\"consumed_api\", service=\"drive.googleapis.com\""

  drive_all       = "sum(increase({${local.drive_requests}}[${var.error_window}]))"
  drive_5xx       = "sum(increase({${local.drive_requests}, response_code_class=\"5xx\"}[${var.error_window}]))"
  drive_throttled = "sum(increase({${local.drive_requests}, response_code=~\"403|429\"}[${var.error_window}]))"

  notification_channels = [for c in google_monitoring_notification_channel.owner_email : c.name]
}

resource "google_monitoring_notification_channel" "owner_email" {
  count = local.alerting

  project      = var.project_id
  display_name = "CoreTools owner (email)"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }

  lifecycle {
    precondition {
      condition     = var.alert_email != null
      error_message = "Set alert_email (in terraform.tfvars) or set enable_alerting = false."
    }
  }

  depends_on = [google_project_service.prod]
}

# --- 5xx: Google-side failures ---------------------------------------------
resource "google_monitoring_alert_policy" "drive_5xx" {
  count = local.alerting

  project      = var.project_id
  display_name = "CoreTools: Drive API 5xx ratio"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Drive API 5xx > ${format("%.0f", var.drive_5xx_ratio_threshold * 100)}% of requests over ${var.error_window}"

    condition_prometheus_query_language {
      query               = <<-EOT
        (${local.drive_5xx} / ${local.drive_all}) > ${var.drive_5xx_ratio_threshold}
        and
        ${local.drive_5xx} >= ${var.drive_min_error_count}
      EOT
      duration            = "0s"
      evaluation_interval = "60s"
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = local.notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Google Drive API calls from CoreTools are failing with 5xx. Installed
      copies retry with back-off and users' local data is unaffected.

      1. Check the Google Workspace and Google Cloud status dashboards.
      2. APIs & Services → Google Drive API → Metrics: errors by method.
      3. If it lasts hours or restores fail, follow the runbook: ${var.runbook_url}
    EOT
  }

  depends_on = [google_project_service.prod]
}

# --- 403/429: throttling, quota, policy -------------------------------------
resource "google_monitoring_alert_policy" "drive_throttled" {
  count = local.alerting

  project      = var.project_id
  display_name = "CoreTools: Drive API 403/429 ratio"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Drive API 403/429 > ${format("%.0f", var.drive_throttle_ratio_threshold * 100)}% of requests over ${var.error_window}"

    condition_prometheus_query_language {
      query               = <<-EOT
        (${local.drive_throttled} / ${local.drive_all}) > ${var.drive_throttle_ratio_threshold}
        and
        ${local.drive_throttled} >= ${var.drive_min_error_count}
      EOT
      duration            = "0s"
      evaluation_interval = "60s"
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = local.notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Many Drive API requests from CoreTools get 403 or 429. Usually rate
      limiting (rateLimitExceeded / userRateLimitExceeded / 429), which the app
      retries; 403 also covers full user storage and Workspace policies.

      1. APIs & Services → Google Drive API → Metrics: traffic by response code and method.
      2. IAM & Admin → Quotas & System Limits, filtered to the Drive API.
      3. A spike right after a release suggests a client bug (request loop).
      Runbook: ${var.runbook_url}
    EOT
  }

  depends_on = [google_project_service.prod]
}

# --- rate quota above 70% of the limit --------------------------------------
resource "google_monitoring_alert_policy" "drive_quota_usage" {
  count = local.alerting

  project      = var.project_id
  display_name = "CoreTools: Drive API quota usage"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "Drive API per-minute quota usage > ${format("%.0f", var.quota_usage_threshold * 100)}% of limit"

    condition_prometheus_query_language {
      query               = <<-EOT
        (
          sum by (project_id, quota_metric, location) (
            increase({"serviceruntime.googleapis.com/quota/rate/net_usage", monitored_resource="consumer_quota", service="drive.googleapis.com"}[1m])
          )
          /
          max by (project_id, quota_metric, location) (
            {"serviceruntime.googleapis.com/quota/limit", monitored_resource="consumer_quota", service="drive.googleapis.com", limit_name=~"${var.quota_limit_name_regex}", limit_name!~"${var.quota_limit_name_exclude_regex}"}
          )
        ) > ${var.quota_usage_threshold}
      EOT
      duration            = "300s"
      evaluation_interval = "60s"
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = local.notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      CoreTools' Drive API usage has stayed above ${format("%.0f", var.quota_usage_threshold * 100)}% of a
      per-minute rate limit for 5 minutes. Past 100%, users get 403/429 and
      backups slow to the app's retry back-off.

      1. IAM & Admin → Quotas & System Limits → Drive API: which limit, and the trend.
      2. If growth is real, request an increase there (Edit quota).
      3. If usage jumped after a release, suspect a request loop in the client.
      Runbook: ${var.runbook_url}
    EOT
  }

  depends_on = [google_project_service.prod]
}

# --- backstop: a Drive quota was actually exceeded --------------------------
# Doesn't depend on the limit metric (which Google samples infrequently), so
# it still fires if the ratio above can't be computed.
resource "google_monitoring_alert_policy" "drive_quota_exceeded" {
  count = local.alerting

  project      = var.project_id
  display_name = "CoreTools: Drive API quota exceeded"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "Drive API quota/exceeded is true"

    condition_threshold {
      filter          = "metric.type=\"serviceruntime.googleapis.com/quota/exceeded\" AND resource.type=\"consumer_quota\" AND resource.label.service=\"drive.googleapis.com\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_COUNT_TRUE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.limit_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  notification_channels = local.notification_channels

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Google is rejecting CoreTools' Drive API requests for exceeding a quota
      (see the limit_name label). Request an increase under IAM & Admin →
      Quotas & System Limits → Drive API. Runbook: ${var.runbook_url}
    EOT
  }

  depends_on = [google_project_service.prod]
}
