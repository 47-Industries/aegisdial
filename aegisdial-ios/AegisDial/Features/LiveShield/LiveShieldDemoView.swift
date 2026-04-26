import SwiftUI

// Demo picker + runner. Lists the canned scenarios; tapping one runs
// it through the real shield endpoints so the UI behaves identically
// to a real scam call. A "I'm on a real scam call" should NEVER use
// this path — this is an education / proof tool.

struct LiveShieldDemoView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var activeRunner: LiveShieldDemoRunner?

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text("These are safe, pre-scripted scenarios. No real call is placed. They post transcripts to the backend exactly like a real shielded call, so you see the real UI react.")
            .font(AegisType.caption)
            .foregroundStyle(AegisColor.textSecondary)
        }
        ForEach(LiveShieldDemoRunner.scenarios) { s in
          Button {
            let runner = LiveShieldDemoRunner(scenario: s)
            activeRunner = runner
            Task { await runner.start() }
          } label: {
            HStack(spacing: AegisSpacing.m) {
              Image(systemName: s.icon)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(AegisColor.accent)
                .frame(width: 40, height: 40)
                .background(AegisColor.accentGlow)
                .clipShape(Circle())
              VStack(alignment: .leading, spacing: 2) {
                Text(s.title).font(AegisType.bodyBold).foregroundStyle(AegisColor.textPrimary)
                Text(s.description).font(AegisType.caption).foregroundStyle(AegisColor.textSecondary)
              }
              Spacer()
              Image(systemName: "play.fill").foregroundStyle(AegisColor.textSecondary)
            }
          }
          .buttonStyle(.plain)
        }
      }
      .scrollContentBackground(.hidden)
      .background(AegisColor.background)
      .navigationTitle("Try a demo call")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Close") { dismiss() }
        }
      }
    }
    .fullScreenCover(item: $activeRunner) { runner in
      LiveShieldActiveView(session: runner.session)
        .onDisappear { Task { await runner.stop() } }
    }
  }
}
