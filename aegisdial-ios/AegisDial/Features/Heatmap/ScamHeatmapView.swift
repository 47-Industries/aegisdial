import SwiftUI
import MapKit

// Scam heatmap. Shows a US map with per-state circles sized by the
// trailing-30-day report volume. Users tap a state to see category
// breakdown and absolute counts.
//
// This is a community-intelligence differentiator — Truecaller / Hiya
// show caller ID but not geographic scam waves. AegisDial surfaces
// "Alabama state-tax impersonation spiked this week" so users know to
// be extra-skeptical when their phone rings.

struct ScamHeatmapView: View {
  @State private var regions: [APIClient.HeatmapRegion] = []
  @State private var maxReports: Int = 1
  @State private var loading: Bool = true
  @State private var error: String?
  @State private var selectedRegion: APIClient.HeatmapRegion?
  @State private var cameraPosition = MapCameraPosition.region(
    MKCoordinateRegion(
      center: CLLocationCoordinate2D(latitude: 39.8283, longitude: -98.5795),
      span: MKCoordinateSpan(latitudeDelta: 45, longitudeDelta: 55)
    )
  )

  var body: some View {
    ZStack {
      Map(position: $cameraPosition) {
        ForEach(regions) { r in
          Annotation(
            r.regionCode,
            coordinate: CLLocationCoordinate2D(latitude: r.lat, longitude: r.lng),
            anchor: .center
          ) {
            circle(for: r)
              .onTapGesture { selectedRegion = r }
          }
        }
      }
      .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))

      if loading {
        VStack {
          Spacer()
          ProgressView("Loading heatmap…")
            .padding(12)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding()
          Spacer()
        }
      } else if let error {
        VStack {
          ErrorBanner(message: error) { Task { await load() } }
            .padding()
          Spacer()
        }
      }

      VStack {
        Spacer()
        legend
          .padding()
      }
    }
    .navigationTitle("Scam Heatmap")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $selectedRegion) { r in
      RegionDetailSheet(region: r)
        .presentationDetents([.medium])
    }
    .task { await load() }
    .refreshable { await load() }
  }

  private func circle(for r: APIClient.HeatmapRegion) -> some View {
    let t: CGFloat = maxReports > 0 ? CGFloat(r.reports30d) / CGFloat(maxReports) : 0
    let size: CGFloat = 14 + t * 40     // 14..54pt
    return Circle()
      .fill(color(for: t))
      .frame(width: size, height: size)
      .overlay(
        Circle().stroke(Color.white.opacity(0.4), lineWidth: 1)
      )
      .shadow(color: color(for: t).opacity(0.6), radius: 4)
      .accessibilityLabel("\(r.regionName): \(r.reports30d) scam reports in the last 30 days")
  }

  private func color(for t: CGFloat) -> Color {
    // Green (low) → amber (mid) → red (high)
    if t < 0.25 { return AegisColor.verdictTrusted.opacity(0.55) }
    if t < 0.6  { return AegisColor.verdictSuspicious.opacity(0.70) }
    return AegisColor.verdictSpoofHigh.opacity(0.80)
  }

  private var legend: some View {
    HStack(spacing: 12) {
      swatch(color: AegisColor.verdictTrusted, label: "Low")
      swatch(color: AegisColor.verdictSuspicious, label: "Medium")
      swatch(color: AegisColor.verdictSpoofHigh, label: "High")
      Spacer()
      Text("30-day reports")
        .font(.caption2)
        .foregroundStyle(AegisColor.textSecondary)
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(.ultraThinMaterial)
    .clipShape(RoundedRectangle(cornerRadius: 12))
  }

  private func swatch(color: Color, label: String) -> some View {
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 10, height: 10).accessibilityHidden(true)
      Text(label).font(.caption2).foregroundStyle(AegisColor.textPrimary)
    }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    error = nil
    do {
      let resp = try await APIClient.shared.scamHeatmap()
      regions = resp.regions
      maxReports = max(resp.maxReports30d, 1)
    } catch let err {
      error = err.localizedDescription
    }
  }
}

private struct RegionDetailSheet: View {
  let region: APIClient.HeatmapRegion
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: AegisSpacing.m) {
      HStack {
        Text(region.regionName)
          .font(.system(size: 28, weight: .bold))
          .foregroundStyle(AegisColor.textPrimary)
        Spacer()
        Button("Close") { dismiss() }
      }
      Text("\(region.reports30d) reports in the last 30 days")
        .font(AegisType.bodyBold)
        .foregroundStyle(AegisColor.verdictSpoofHigh)
      Text("\(region.reportsAllTime) reports all time")
        .font(AegisType.caption)
        .foregroundStyle(AegisColor.textSecondary)
      if let cat = region.topScamCategory {
        HStack {
          Image(systemName: "flame.fill")
            .foregroundStyle(AegisColor.verdictSuspicious)
            .accessibilityHidden(true)
          Text("Most reported: \(cat.replacingOccurrences(of: "_", with: " "))")
            .font(AegisType.body)
            .foregroundStyle(AegisColor.textPrimary)
        }
        .padding(.top, AegisSpacing.s)
      }
      Spacer()
    }
    .padding(AegisSpacing.l)
  }
}
