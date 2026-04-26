import SwiftUI
import ContactsUI
import Contacts

// UIViewControllerRepresentable wrapper around CNContactPickerViewController.
// Presents the system contact picker and hands back a single
// (name, phone) tuple. Phone is returned verbatim as the user saved it —
// the consuming form is responsible for E.164 normalization.
//
// iOS only loads contacts when we present this; it does NOT grant a
// blanket read permission, and the user sees the system's own contact
// picker UI (not ours). That matches Apple's preferred pattern in
// iOS 18: data-narrow scopes instead of full-contacts authorization.

struct ContactPickerCoordinator: UIViewControllerRepresentable {
  let onPick: (_ name: String, _ phone: String) -> Void

  func makeUIViewController(context: Context) -> CNContactPickerViewController {
    let picker = CNContactPickerViewController()
    picker.delegate = context.coordinator
    // Predicate limits the picker to contacts that actually have a phone
    // number so the user can't select someone without one.
    picker.predicateForEnablingContact = NSPredicate(format: "phoneNumbers.@count > 0")
    // Drilling into a contact shows only phoneNumbers — cleaner UX.
    picker.displayedPropertyKeys = [CNContactPhoneNumbersKey]
    return picker
  }

  func updateUIViewController(_ uiViewController: CNContactPickerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

  final class Coordinator: NSObject, CNContactPickerDelegate {
    let onPick: (String, String) -> Void
    init(onPick: @escaping (String, String) -> Void) { self.onPick = onPick }

    // When the user taps a specific phone number (not just a contact),
    // `didSelect contactProperty` fires with that exact number.
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contactProperty: CNContactProperty) {
      let name = [contactProperty.contact.givenName, contactProperty.contact.familyName]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
      let phone = (contactProperty.value as? CNPhoneNumber)?.stringValue ?? ""
      onPick(name, phone)
    }

    // When the user picks a contact (not drilled in), take the first phone.
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
      let name = [contact.givenName, contact.familyName]
        .filter { !$0.isEmpty }
        .joined(separator: " ")
      let phone = contact.phoneNumbers.first?.value.stringValue ?? ""
      onPick(name, phone)
    }
  }
}
