'use client'
import { Page, cardStyle } from '@/components/ui'
import { PasswordForm } from '@/components/PasswordForm'

export default function AccountPage() {
  return (
    <Page title="Your account">
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Change password</h3>
        <p style={{ fontSize: 13, color: '#7A9BBD', marginTop: -6 }}>If an admin gave you a temporary password, replace it here.</p>
        <PasswordForm />
      </div>
    </Page>
  )
}
