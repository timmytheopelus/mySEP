import Form from "./form";
import styles from "../forms.module.css";

export const metadata = { title: "Atur password - KEP Keuskupan Bandung", referrer: "no-referrer" };

export default function Page() {
  return (
    <main className={styles.main}>
      <h1>Atur password</h1>
      <Form />
    </main>
  );
}
