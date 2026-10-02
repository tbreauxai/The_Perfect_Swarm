export interface ValidationOutcome<T> {
    success: boolean;
    data: T;
    repaired: boolean;
    errors?: string[];
}
