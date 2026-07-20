export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      areas: {
        Row: {
          district_id: string
          id: string
          name: Json
          org_id: string
        }
        Insert: {
          district_id: string
          id?: string
          name: Json
          org_id: string
        }
        Update: {
          district_id?: string
          id?: string
          name?: Json
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "areas_district_id_fkey"
            columns: ["district_id"]
            isOneToOne: false
            referencedRelation: "districts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "areas_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          additional_phones: string[]
          assigned_agent_id: string | null
          banking_readiness: Json
          company_name: string | null
          consent_at: string | null
          consent_marketing: boolean
          contact_kind: Database["public"]["Enums"]["contact_kind"]
          contact_types: string[]
          created_at: string
          created_by: string | null
          display_name: string | null
          email: string | null
          first_name: string | null
          gdpr_notes: string | null
          has_whatsapp: boolean
          id: string
          is_archived: boolean
          kyc: Json
          languages: string[]
          last_name: string | null
          merged_into_id: string | null
          nationality: string | null
          notes: string | null
          org_id: string
          phone_e164: string | null
          phone_raw: string | null
          preferences: Json
          preferred_channel: Database["public"]["Enums"]["comm_channel"] | null
          psychology: Database["public"]["Enums"]["psychology_profile"] | null
          source: Database["public"]["Enums"]["lead_source"] | null
          source_detail: string | null
          telegram_username: string | null
          temperature: Database["public"]["Enums"]["temperature"]
          updated_at: string
        }
        Insert: {
          additional_phones?: string[]
          assigned_agent_id?: string | null
          banking_readiness?: Json
          company_name?: string | null
          consent_at?: string | null
          consent_marketing?: boolean
          contact_kind?: Database["public"]["Enums"]["contact_kind"]
          contact_types?: string[]
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email?: string | null
          first_name?: string | null
          gdpr_notes?: string | null
          has_whatsapp?: boolean
          id?: string
          is_archived?: boolean
          kyc?: Json
          languages?: string[]
          last_name?: string | null
          merged_into_id?: string | null
          nationality?: string | null
          notes?: string | null
          org_id: string
          phone_e164?: string | null
          phone_raw?: string | null
          preferences?: Json
          preferred_channel?: Database["public"]["Enums"]["comm_channel"] | null
          psychology?: Database["public"]["Enums"]["psychology_profile"] | null
          source?: Database["public"]["Enums"]["lead_source"] | null
          source_detail?: string | null
          telegram_username?: string | null
          temperature?: Database["public"]["Enums"]["temperature"]
          updated_at?: string
        }
        Update: {
          additional_phones?: string[]
          assigned_agent_id?: string | null
          banking_readiness?: Json
          company_name?: string | null
          consent_at?: string | null
          consent_marketing?: boolean
          contact_kind?: Database["public"]["Enums"]["contact_kind"]
          contact_types?: string[]
          created_at?: string
          created_by?: string | null
          display_name?: string | null
          email?: string | null
          first_name?: string | null
          gdpr_notes?: string | null
          has_whatsapp?: boolean
          id?: string
          is_archived?: boolean
          kyc?: Json
          languages?: string[]
          last_name?: string | null
          merged_into_id?: string | null
          nationality?: string | null
          notes?: string | null
          org_id?: string
          phone_e164?: string | null
          phone_raw?: string | null
          preferences?: Json
          preferred_channel?: Database["public"]["Enums"]["comm_channel"] | null
          psychology?: Database["public"]["Enums"]["psychology_profile"] | null
          source?: Database["public"]["Enums"]["lead_source"] | null
          source_detail?: string | null
          telegram_username?: string | null
          temperature?: Database["public"]["Enums"]["temperature"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_merged_into_id_fkey"
            columns: ["merged_into_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cyprus_config: {
        Row: {
          description: string | null
          key: string
          source_note: string | null
          updated_at: string
          updated_by: string | null
          value: Json
          verified_at: string | null
        }
        Insert: {
          description?: string | null
          key: string
          source_note?: string | null
          updated_at?: string
          updated_by?: string | null
          value: Json
          verified_at?: string | null
        }
        Update: {
          description?: string | null
          key?: string
          source_note?: string | null
          updated_at?: string
          updated_by?: string | null
          value?: Json
          verified_at?: string | null
        }
        Relationships: []
      }
      deal_stages: {
        Row: {
          deal_type: Database["public"]["Enums"]["deal_type"]
          id: string
          is_lost: boolean
          is_won: boolean
          name: string
          org_id: string
          sort_order: number
        }
        Insert: {
          deal_type: Database["public"]["Enums"]["deal_type"]
          id?: string
          is_lost?: boolean
          is_won?: boolean
          name: string
          org_id: string
          sort_order: number
        }
        Update: {
          deal_type?: Database["public"]["Enums"]["deal_type"]
          id?: string
          is_lost?: boolean
          is_won?: boolean
          name?: string
          org_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "deal_stages_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      deals: {
        Row: {
          agent_id: string | null
          buyer_contact_id: string | null
          commission_split_notes: string | null
          created_at: string
          created_by: string | null
          deal_type: Database["public"]["Enums"]["deal_type"]
          expected_value: number | null
          health: Json
          health_score: number
          id: string
          last_activity_at: string
          lost_at: string | null
          lost_reason: string | null
          org_id: string
          property_id: string | null
          seller_contact_id: string | null
          stage_entered_at: string
          stage_id: string
          status: Database["public"]["Enums"]["deal_status"]
          title: string
          updated_at: string
          won_at: string | null
        }
        Insert: {
          agent_id?: string | null
          buyer_contact_id?: string | null
          commission_split_notes?: string | null
          created_at?: string
          created_by?: string | null
          deal_type?: Database["public"]["Enums"]["deal_type"]
          expected_value?: number | null
          health?: Json
          health_score?: number
          id?: string
          last_activity_at?: string
          lost_at?: string | null
          lost_reason?: string | null
          org_id: string
          property_id?: string | null
          seller_contact_id?: string | null
          stage_entered_at?: string
          stage_id: string
          status?: Database["public"]["Enums"]["deal_status"]
          title: string
          updated_at?: string
          won_at?: string | null
        }
        Update: {
          agent_id?: string | null
          buyer_contact_id?: string | null
          commission_split_notes?: string | null
          created_at?: string
          created_by?: string | null
          deal_type?: Database["public"]["Enums"]["deal_type"]
          expected_value?: number | null
          health?: Json
          health_score?: number
          id?: string
          last_activity_at?: string
          lost_at?: string | null
          lost_reason?: string | null
          org_id?: string
          property_id?: string | null
          seller_contact_id?: string | null
          stage_entered_at?: string
          stage_id?: string
          status?: Database["public"]["Enums"]["deal_status"]
          title?: string
          updated_at?: string
          won_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deals_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_buyer_contact_id_fkey"
            columns: ["buyer_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_seller_contact_id_fkey"
            columns: ["seller_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deals_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "deal_stages"
            referencedColumns: ["id"]
          },
        ]
      }
      districts: {
        Row: {
          code: string
          id: string
          name: Json
          org_id: string
          sort_order: number
        }
        Insert: {
          code: string
          id?: string
          name: Json
          org_id: string
          sort_order?: number
        }
        Update: {
          code?: string
          id?: string
          name?: Json
          org_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "districts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          doc_type: Database["public"]["Enums"]["document_type"]
          entity_id: string
          entity_type: string
          id: string
          org_id: string
          storage_path: string
          title: string
          uploaded_by: string | null
          visibility: string
        }
        Insert: {
          created_at?: string
          doc_type?: Database["public"]["Enums"]["document_type"]
          entity_id: string
          entity_type: string
          id?: string
          org_id: string
          storage_path: string
          title: string
          uploaded_by?: string | null
          visibility?: string
        }
        Update: {
          created_at?: string
          doc_type?: Database["public"]["Enums"]["document_type"]
          entity_id?: string
          entity_type?: string
          id?: string
          org_id?: string
          storage_path?: string
          title?: string
          uploaded_by?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          actor_id: string | null
          entity_id: string | null
          entity_type: string
          event_type: string
          hash: string | null
          id: number
          occurred_at: string
          org_id: string
          payload: Json
          prev_hash: string | null
        }
        Insert: {
          actor_id?: string | null
          entity_id?: string | null
          entity_type: string
          event_type: string
          hash?: string | null
          id?: never
          occurred_at?: string
          org_id: string
          payload?: Json
          prev_hash?: string | null
        }
        Update: {
          actor_id?: string | null
          entity_id?: string | null
          entity_type?: string
          event_type?: string
          hash?: string | null
          id?: never
          occurred_at?: string
          org_id?: string
          payload?: Json
          prev_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      key_movements: {
        Row: {
          action: Database["public"]["Enums"]["key_action"]
          created_by: string | null
          holder_name: string | null
          holder_profile_id: string | null
          id: string
          key_id: string
          note: string | null
          occurred_at: string
          org_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["key_action"]
          created_by?: string | null
          holder_name?: string | null
          holder_profile_id?: string | null
          id?: string
          key_id: string
          note?: string | null
          occurred_at?: string
          org_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["key_action"]
          created_by?: string | null
          holder_name?: string | null
          holder_profile_id?: string | null
          id?: string
          key_id?: string
          note?: string | null
          occurred_at?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "key_movements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_movements_holder_profile_id_fkey"
            columns: ["holder_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_movements_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "property_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          assigned_agent_id: string | null
          channel: Database["public"]["Enums"]["comm_channel"] | null
          contact_id: string | null
          converted_deal_id: string | null
          created_at: string
          criteria: Json
          first_call_at: string | null
          first_response_at: string | null
          id: string
          lost_reason: string | null
          message: string | null
          org_id: string
          property_id: string | null
          received_at: string
          source: Database["public"]["Enums"]["lead_source"]
          status: Database["public"]["Enums"]["lead_status"]
          updated_at: string
        }
        Insert: {
          assigned_agent_id?: string | null
          channel?: Database["public"]["Enums"]["comm_channel"] | null
          contact_id?: string | null
          converted_deal_id?: string | null
          created_at?: string
          criteria?: Json
          first_call_at?: string | null
          first_response_at?: string | null
          id?: string
          lost_reason?: string | null
          message?: string | null
          org_id: string
          property_id?: string | null
          received_at?: string
          source?: Database["public"]["Enums"]["lead_source"]
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
        }
        Update: {
          assigned_agent_id?: string | null
          channel?: Database["public"]["Enums"]["comm_channel"] | null
          contact_id?: string | null
          converted_deal_id?: string | null
          created_at?: string
          criteria?: Json
          first_call_at?: string | null
          first_response_at?: string | null
          id?: string
          lost_reason?: string | null
          message?: string | null
          org_id?: string
          property_id?: string | null
          received_at?: string
          source?: Database["public"]["Enums"]["lead_source"]
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_converted_fk"
            columns: ["converted_deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      mandates: {
        Row: {
          commission_notes: string | null
          commission_pct: number | null
          created_at: string
          created_by: string | null
          expiry_date: string | null
          id: string
          notes: string | null
          org_id: string
          owner_contact_id: string | null
          property_id: string
          renewal_reminder_days: number
          signed_document_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["mandate_status"]
          type: Database["public"]["Enums"]["mandate_type"]
          updated_at: string
        }
        Insert: {
          commission_notes?: string | null
          commission_pct?: number | null
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          id?: string
          notes?: string | null
          org_id: string
          owner_contact_id?: string | null
          property_id: string
          renewal_reminder_days?: number
          signed_document_id?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["mandate_status"]
          type: Database["public"]["Enums"]["mandate_type"]
          updated_at?: string
        }
        Update: {
          commission_notes?: string | null
          commission_pct?: number | null
          created_at?: string
          created_by?: string | null
          expiry_date?: string | null
          id?: string
          notes?: string | null
          org_id?: string
          owner_contact_id?: string | null
          property_id?: string
          renewal_reminder_days?: number
          signed_document_id?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["mandate_status"]
          type?: Database["public"]["Enums"]["mandate_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mandates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_owner_contact_id_fkey"
            columns: ["owner_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_signed_doc_fk"
            columns: ["signed_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          amount: number
          contact_id: string | null
          created_at: string
          created_by: string | null
          deal_id: string
          decided_at: string | null
          id: string
          org_id: string
          property_id: string | null
          status: Database["public"]["Enums"]["offer_status"]
          terms: string | null
          valid_until: string | null
        }
        Insert: {
          amount: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          deal_id: string
          decided_at?: string | null
          id?: string
          org_id: string
          property_id?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
          terms?: string | null
          valid_until?: string | null
        }
        Update: {
          amount?: number
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          deal_id?: string
          decided_at?: string | null
          id?: string
          org_id?: string
          property_id?: string | null
          status?: Database["public"]["Enums"]["offer_status"]
          terms?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offers_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          slug: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          slug: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          slug?: string
        }
        Relationships: []
      }
      payment_plans: {
        Row: {
          created_at: string
          id: string
          installments: Json
          name: string
          org_id: string
          project_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          installments?: Json
          name: string
          org_id: string
          project_id: string
        }
        Update: {
          created_at?: string
          id?: string
          installments?: Json
          name?: string
          org_id?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_plans_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_plans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      price_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          id: string
          new_price: number | null
          note: string | null
          old_price: number | null
          org_id: string
          property_id: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          new_price?: number | null
          note?: string | null
          old_price?: number | null
          org_id: string
          property_id: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          id?: string
          new_price?: number | null
          note?: string | null
          old_price?: number | null
          org_id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_history_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      price_list_items: {
        Row: {
          list_price: number
          price_list_id: string
          unit_id: string
        }
        Insert: {
          list_price: number
          price_list_id: string
          unit_id: string
        }
        Update: {
          list_price?: number
          price_list_id?: string
          unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "price_list_items_price_list_id_fkey"
            columns: ["price_list_id"]
            isOneToOne: false
            referencedRelation: "price_lists"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_list_items_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      price_lists: {
        Row: {
          created_at: string
          created_by: string | null
          effective_date: string
          id: string
          notes: string | null
          org_id: string
          project_id: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          notes?: string | null
          org_id: string
          project_id: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_date?: string
          id?: string
          notes?: string | null
          org_id?: string
          project_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "price_lists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_lists_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "price_lists_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          locale: string
          org_id: string
          phone_e164: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name: string
          id: string
          is_active?: boolean
          locale?: string
          org_id: string
          phone_e164?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          locale?: string
          org_id?: string
          phone_e164?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          address: string | null
          amenities_notes: string | null
          area_id: string | null
          asking_price: number | null
          assigned_agent_id: string | null
          basement_sqm: number | null
          bathrooms: number | null
          bedrooms: number | null
          block: string | null
          building_density_pct: number | null
          constraints_notes: string | null
          construction_status: string | null
          coverage_ratio_pct: number | null
          covered_area_sqm: number | null
          created_at: string
          created_by: string | null
          currency: string
          delivery_date: string | null
          developer_contact_id: string | null
          district_id: string | null
          electricity_available: boolean | null
          encumbrances_notes: string | null
          energy_class: string | null
          features: string[]
          floor_number: number | null
          has_storage: boolean | null
          id: string
          internal_notes: string | null
          kind: Database["public"]["Enums"]["property_kind"]
          location: unknown
          max_floors: number | null
          max_height_m: number | null
          min_acceptable_price: number | null
          org_id: string
          owner_contact_id: string | null
          owner_net_price: number | null
          parent_id: string | null
          parking_spaces: number | null
          permit_status: Database["public"]["Enums"]["permit_status"]
          planning_zone_code: string | null
          plot_area_sqm: number | null
          postal_code: string | null
          property_type: Database["public"]["Enums"]["property_type"]
          public_description: Json
          published_at: string | null
          quality_score: number
          reference: string
          rent_price_month: number | null
          road_frontage_m: number | null
          roof_garden_sqm: number | null
          sea_distance_m: number | null
          share_of_land: string | null
          short_description: Json
          sold_at: string | null
          status: Database["public"]["Enums"]["property_status"]
          title: Json
          title_deed_status: Database["public"]["Enums"]["title_deed_status"]
          total_floors: number | null
          transaction_type: Database["public"]["Enums"]["transaction_type"]
          unit_number: string | null
          updated_at: string
          vat_status: Database["public"]["Enums"]["vat_status"]
          veranda_sqm: number | null
          visibility: Database["public"]["Enums"]["visibility_level"]
          water_available: boolean | null
          wc: number | null
          year_built: number | null
        }
        Insert: {
          address?: string | null
          amenities_notes?: string | null
          area_id?: string | null
          asking_price?: number | null
          assigned_agent_id?: string | null
          basement_sqm?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          block?: string | null
          building_density_pct?: number | null
          constraints_notes?: string | null
          construction_status?: string | null
          coverage_ratio_pct?: number | null
          covered_area_sqm?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string
          delivery_date?: string | null
          developer_contact_id?: string | null
          district_id?: string | null
          electricity_available?: boolean | null
          encumbrances_notes?: string | null
          energy_class?: string | null
          features?: string[]
          floor_number?: number | null
          has_storage?: boolean | null
          id?: string
          internal_notes?: string | null
          kind?: Database["public"]["Enums"]["property_kind"]
          location?: unknown
          max_floors?: number | null
          max_height_m?: number | null
          min_acceptable_price?: number | null
          org_id: string
          owner_contact_id?: string | null
          owner_net_price?: number | null
          parent_id?: string | null
          parking_spaces?: number | null
          permit_status?: Database["public"]["Enums"]["permit_status"]
          planning_zone_code?: string | null
          plot_area_sqm?: number | null
          postal_code?: string | null
          property_type: Database["public"]["Enums"]["property_type"]
          public_description?: Json
          published_at?: string | null
          quality_score?: number
          reference: string
          rent_price_month?: number | null
          road_frontage_m?: number | null
          roof_garden_sqm?: number | null
          sea_distance_m?: number | null
          share_of_land?: string | null
          short_description?: Json
          sold_at?: string | null
          status?: Database["public"]["Enums"]["property_status"]
          title?: Json
          title_deed_status?: Database["public"]["Enums"]["title_deed_status"]
          total_floors?: number | null
          transaction_type?: Database["public"]["Enums"]["transaction_type"]
          unit_number?: string | null
          updated_at?: string
          vat_status?: Database["public"]["Enums"]["vat_status"]
          veranda_sqm?: number | null
          visibility?: Database["public"]["Enums"]["visibility_level"]
          water_available?: boolean | null
          wc?: number | null
          year_built?: number | null
        }
        Update: {
          address?: string | null
          amenities_notes?: string | null
          area_id?: string | null
          asking_price?: number | null
          assigned_agent_id?: string | null
          basement_sqm?: number | null
          bathrooms?: number | null
          bedrooms?: number | null
          block?: string | null
          building_density_pct?: number | null
          constraints_notes?: string | null
          construction_status?: string | null
          coverage_ratio_pct?: number | null
          covered_area_sqm?: number | null
          created_at?: string
          created_by?: string | null
          currency?: string
          delivery_date?: string | null
          developer_contact_id?: string | null
          district_id?: string | null
          electricity_available?: boolean | null
          encumbrances_notes?: string | null
          energy_class?: string | null
          features?: string[]
          floor_number?: number | null
          has_storage?: boolean | null
          id?: string
          internal_notes?: string | null
          kind?: Database["public"]["Enums"]["property_kind"]
          location?: unknown
          max_floors?: number | null
          max_height_m?: number | null
          min_acceptable_price?: number | null
          org_id?: string
          owner_contact_id?: string | null
          owner_net_price?: number | null
          parent_id?: string | null
          parking_spaces?: number | null
          permit_status?: Database["public"]["Enums"]["permit_status"]
          planning_zone_code?: string | null
          plot_area_sqm?: number | null
          postal_code?: string | null
          property_type?: Database["public"]["Enums"]["property_type"]
          public_description?: Json
          published_at?: string | null
          quality_score?: number
          reference?: string
          rent_price_month?: number | null
          road_frontage_m?: number | null
          roof_garden_sqm?: number | null
          sea_distance_m?: number | null
          share_of_land?: string | null
          short_description?: Json
          sold_at?: string | null
          status?: Database["public"]["Enums"]["property_status"]
          title?: Json
          title_deed_status?: Database["public"]["Enums"]["title_deed_status"]
          total_floors?: number | null
          transaction_type?: Database["public"]["Enums"]["transaction_type"]
          unit_number?: string | null
          updated_at?: string
          vat_status?: Database["public"]["Enums"]["vat_status"]
          veranda_sqm?: number | null
          visibility?: Database["public"]["Enums"]["visibility_level"]
          water_available?: boolean | null
          wc?: number | null
          year_built?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "properties_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_developer_contact_id_fkey"
            columns: ["developer_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_district_id_fkey"
            columns: ["district_id"]
            isOneToOne: false
            referencedRelation: "districts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_owner_contact_id_fkey"
            columns: ["owner_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_keys: {
        Row: {
          created_at: string
          current_holder_name: string | null
          current_holder_profile_id: string | null
          description: string | null
          id: string
          key_code: string
          org_id: string
          property_id: string
          status: Database["public"]["Enums"]["key_status"]
        }
        Insert: {
          created_at?: string
          current_holder_name?: string | null
          current_holder_profile_id?: string | null
          description?: string | null
          id?: string
          key_code: string
          org_id: string
          property_id: string
          status?: Database["public"]["Enums"]["key_status"]
        }
        Update: {
          created_at?: string
          current_holder_name?: string | null
          current_holder_profile_id?: string | null
          description?: string | null
          id?: string
          key_code?: string
          org_id?: string
          property_id?: string
          status?: Database["public"]["Enums"]["key_status"]
        }
        Relationships: [
          {
            foreignKeyName: "property_keys_current_holder_profile_id_fkey"
            columns: ["current_holder_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_keys_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_keys_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_media: {
        Row: {
          alt: Json
          created_at: string
          created_by: string | null
          exif_stripped: boolean
          external_url: string | null
          height: number | null
          id: string
          is_cover: boolean
          kind: Database["public"]["Enums"]["media_kind"]
          org_id: string
          path_card: string | null
          path_full: string | null
          path_thumb: string | null
          property_id: string
          sort_order: number
          storage_path_original: string | null
          watermarked: boolean
          width: number | null
        }
        Insert: {
          alt?: Json
          created_at?: string
          created_by?: string | null
          exif_stripped?: boolean
          external_url?: string | null
          height?: number | null
          id?: string
          is_cover?: boolean
          kind?: Database["public"]["Enums"]["media_kind"]
          org_id: string
          path_card?: string | null
          path_full?: string | null
          path_thumb?: string | null
          property_id: string
          sort_order?: number
          storage_path_original?: string | null
          watermarked?: boolean
          width?: number | null
        }
        Update: {
          alt?: Json
          created_at?: string
          created_by?: string | null
          exif_stripped?: boolean
          external_url?: string | null
          height?: number | null
          id?: string
          is_cover?: boolean
          kind?: Database["public"]["Enums"]["media_kind"]
          org_id?: string
          path_card?: string | null
          path_full?: string | null
          path_thumb?: string | null
          property_id?: string
          sort_order?: number
          storage_path_original?: string | null
          watermarked?: boolean
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "property_media_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_media_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_media_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      reference_counters: {
        Row: {
          district_code: string
          last_value: number
          org_id: string
        }
        Insert: {
          district_code: string
          last_value?: number
          org_id: string
        }
        Update: {
          district_code?: string
          last_value?: number
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reference_counters_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assignee_id: string | null
          contact_id: string | null
          created_at: string
          created_by: string | null
          deal_id: string | null
          done_at: string | null
          due_at: string | null
          id: string
          is_done: boolean
          mandate_id: string | null
          org_id: string
          property_id: string | null
          title: string
        }
        Insert: {
          assignee_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          done_at?: string | null
          due_at?: string | null
          id?: string
          is_done?: boolean
          mandate_id?: string | null
          org_id: string
          property_id?: string | null
          title: string
        }
        Update: {
          assignee_id?: string | null
          contact_id?: string | null
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          done_at?: string | null
          due_at?: string | null
          id?: string
          is_done?: boolean
          mandate_id?: string | null
          org_id?: string
          property_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_mandate_id_fkey"
            columns: ["mandate_id"]
            isOneToOne: false
            referencedRelation: "mandates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_mandate_id_fkey"
            columns: ["mandate_id"]
            isOneToOne: false
            referencedRelation: "mandates_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      viewing_slips: {
        Row: {
          created_by: string | null
          geolocation: unknown
          id: string
          org_id: string
          pdf_path: string | null
          signature_path: string
          signature_sha256: string
          signed_at: string
          signer_name: string
          viewing_id: string
        }
        Insert: {
          created_by?: string | null
          geolocation?: unknown
          id?: string
          org_id: string
          pdf_path?: string | null
          signature_path: string
          signature_sha256: string
          signed_at?: string
          signer_name: string
          viewing_id: string
        }
        Update: {
          created_by?: string | null
          geolocation?: unknown
          id?: string
          org_id?: string
          pdf_path?: string | null
          signature_path?: string
          signature_sha256?: string
          signed_at?: string
          signer_name?: string
          viewing_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "viewing_slips_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewing_slips_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewing_slips_viewing_id_fkey"
            columns: ["viewing_id"]
            isOneToOne: true
            referencedRelation: "viewings"
            referencedColumns: ["id"]
          },
        ]
      }
      viewings: {
        Row: {
          agent_id: string
          contact_id: string
          created_at: string
          created_by: string | null
          deal_id: string | null
          duration_min: number
          feedback: Json | null
          id: string
          org_id: string
          owner_notified: boolean
          property_id: string
          route_date: string | null
          route_order: number | null
          scheduled_at: string
          status: Database["public"]["Enums"]["viewing_status"]
          updated_at: string
        }
        Insert: {
          agent_id: string
          contact_id: string
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          duration_min?: number
          feedback?: Json | null
          id?: string
          org_id: string
          owner_notified?: boolean
          property_id: string
          route_date?: string | null
          route_order?: number | null
          scheduled_at: string
          status?: Database["public"]["Enums"]["viewing_status"]
          updated_at?: string
        }
        Update: {
          agent_id?: string
          contact_id?: string
          created_at?: string
          created_by?: string | null
          deal_id?: string | null
          duration_min?: number
          feedback?: Json | null
          id?: string
          org_id?: string
          owner_notified?: boolean
          property_id?: string
          route_date?: string | null
          route_order?: number | null
          scheduled_at?: string
          status?: Database["public"]["Enums"]["viewing_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "viewings_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewings_deal_id_fkey"
            columns: ["deal_id"]
            isOneToOne: false
            referencedRelation: "deals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewings_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "viewings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      mandates_safe: {
        Row: {
          commission_notes: string | null
          commission_pct: number | null
          created_at: string | null
          created_by: string | null
          expiry_date: string | null
          id: string | null
          notes: string | null
          org_id: string | null
          owner_contact_id: string | null
          property_id: string | null
          renewal_reminder_days: number | null
          signed_document_id: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["mandate_status"] | null
          type: Database["public"]["Enums"]["mandate_type"] | null
          updated_at: string | null
        }
        Insert: {
          commission_notes?: never
          commission_pct?: never
          created_at?: string | null
          created_by?: string | null
          expiry_date?: string | null
          id?: string | null
          notes?: string | null
          org_id?: string | null
          owner_contact_id?: string | null
          property_id?: string | null
          renewal_reminder_days?: number | null
          signed_document_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["mandate_status"] | null
          type?: Database["public"]["Enums"]["mandate_type"] | null
          updated_at?: string | null
        }
        Update: {
          commission_notes?: never
          commission_pct?: never
          created_at?: string | null
          created_by?: string | null
          expiry_date?: string | null
          id?: string | null
          notes?: string | null
          org_id?: string | null
          owner_contact_id?: string | null
          property_id?: string | null
          renewal_reminder_days?: number | null
          signed_document_id?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["mandate_status"] | null
          type?: Database["public"]["Enums"]["mandate_type"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mandates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_owner_contact_id_fkey"
            columns: ["owner_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mandates_signed_doc_fk"
            columns: ["signed_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      current_org_id: { Args: never; Returns: string }
      current_role_gnk: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      disablelongtransactions: { Args: never; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      expire_mandates: { Args: never; Returns: undefined }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      longtransactionsenabled: { Args: never; Returns: boolean }
      move_deal_to_stage: {
        Args: { p_deal_id: string; p_stage_id: string }
        Returns: undefined
      }
      next_reference: {
        Args: { p_district_code: string; p_org: string }
        Returns: string
      }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      record_key_movement: {
        Args: {
          p_action: Database["public"]["Enums"]["key_action"]
          p_holder_name?: string
          p_holder_profile_id?: string
          p_key_id: string
          p_note?: string
        }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      verify_events_chain: { Args: { p_org: string }; Returns: boolean }
    }
    Enums: {
      comm_channel:
        | "whatsapp"
        | "telegram"
        | "phone"
        | "email"
        | "sms"
        | "in_person"
        | "other"
      contact_kind: "person" | "company"
      deal_status: "open" | "won" | "lost"
      deal_type: "sale" | "rental" | "antiparoxi" | "advisory"
      document_type:
        | "title_deed"
        | "permit"
        | "contract"
        | "id_document"
        | "proof_of_address"
        | "source_of_funds"
        | "valuation"
        | "plan"
        | "mandate_agreement"
        | "reservation"
        | "proposal"
        | "photo_original"
        | "other"
      key_action: "checkout" | "return" | "transfer" | "mark_lost"
      key_status: "in_office" | "checked_out" | "with_owner" | "lost"
      lead_source:
        | "website"
        | "referral"
        | "facebook"
        | "instagram"
        | "portal"
        | "partner"
        | "walk_in"
        | "whatsapp"
        | "telegram"
        | "phone"
        | "email"
        | "other"
      lead_status:
        | "new"
        | "contacted"
        | "qualified"
        | "converted"
        | "lost"
        | "spam"
      mandate_status: "draft" | "active" | "expired" | "terminated"
      mandate_type: "exclusive" | "open" | "verbal"
      media_kind: "photo" | "video" | "floor_plan" | "virtual_tour"
      offer_status:
        | "submitted"
        | "countered"
        | "accepted"
        | "rejected"
        | "withdrawn"
        | "expired"
      permit_status: "full" | "pending" | "partial" | "none" | "unknown"
      property_kind: "standalone" | "project" | "phase" | "unit"
      property_status:
        | "draft"
        | "available"
        | "reserved"
        | "under_offer"
        | "sold"
        | "rented"
        | "withdrawn"
      property_type:
        | "apartment"
        | "villa"
        | "townhouse"
        | "house"
        | "land"
        | "shop"
        | "office"
        | "building"
        | "hotel"
        | "warehouse"
        | "mixed_use"
        | "other"
      psychology_profile:
        | "investor"
        | "relocation"
        | "luxury"
        | "retirement"
        | "holiday"
        | "local_family"
        | "other"
      temperature: "hot" | "warm" | "cold" | "inactive" | "vip"
      title_deed_status: "separate" | "pending" | "shared" | "none" | "unknown"
      transaction_type: "sale" | "rent" | "sale_or_rent"
      user_role:
        | "admin"
        | "agent"
        | "listing_manager"
        | "owner_portal"
        | "developer_portal"
        | "partner_portal"
      vat_status:
        | "new_vat"
        | "resale_no_vat"
        | "reduced_rate_eligible"
        | "unknown"
      viewing_status: "scheduled" | "completed" | "cancelled" | "no_show"
      visibility_level:
        | "public"
        | "private"
        | "vip"
        | "partner"
        | "off_market"
        | "coming_soon"
        | "archived"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      comm_channel: [
        "whatsapp",
        "telegram",
        "phone",
        "email",
        "sms",
        "in_person",
        "other",
      ],
      contact_kind: ["person", "company"],
      deal_status: ["open", "won", "lost"],
      deal_type: ["sale", "rental", "antiparoxi", "advisory"],
      document_type: [
        "title_deed",
        "permit",
        "contract",
        "id_document",
        "proof_of_address",
        "source_of_funds",
        "valuation",
        "plan",
        "mandate_agreement",
        "reservation",
        "proposal",
        "photo_original",
        "other",
      ],
      key_action: ["checkout", "return", "transfer", "mark_lost"],
      key_status: ["in_office", "checked_out", "with_owner", "lost"],
      lead_source: [
        "website",
        "referral",
        "facebook",
        "instagram",
        "portal",
        "partner",
        "walk_in",
        "whatsapp",
        "telegram",
        "phone",
        "email",
        "other",
      ],
      lead_status: [
        "new",
        "contacted",
        "qualified",
        "converted",
        "lost",
        "spam",
      ],
      mandate_status: ["draft", "active", "expired", "terminated"],
      mandate_type: ["exclusive", "open", "verbal"],
      media_kind: ["photo", "video", "floor_plan", "virtual_tour"],
      offer_status: [
        "submitted",
        "countered",
        "accepted",
        "rejected",
        "withdrawn",
        "expired",
      ],
      permit_status: ["full", "pending", "partial", "none", "unknown"],
      property_kind: ["standalone", "project", "phase", "unit"],
      property_status: [
        "draft",
        "available",
        "reserved",
        "under_offer",
        "sold",
        "rented",
        "withdrawn",
      ],
      property_type: [
        "apartment",
        "villa",
        "townhouse",
        "house",
        "land",
        "shop",
        "office",
        "building",
        "hotel",
        "warehouse",
        "mixed_use",
        "other",
      ],
      psychology_profile: [
        "investor",
        "relocation",
        "luxury",
        "retirement",
        "holiday",
        "local_family",
        "other",
      ],
      temperature: ["hot", "warm", "cold", "inactive", "vip"],
      title_deed_status: ["separate", "pending", "shared", "none", "unknown"],
      transaction_type: ["sale", "rent", "sale_or_rent"],
      user_role: [
        "admin",
        "agent",
        "listing_manager",
        "owner_portal",
        "developer_portal",
        "partner_portal",
      ],
      vat_status: [
        "new_vat",
        "resale_no_vat",
        "reduced_rate_eligible",
        "unknown",
      ],
      viewing_status: ["scheduled", "completed", "cancelled", "no_show"],
      visibility_level: [
        "public",
        "private",
        "vip",
        "partner",
        "off_market",
        "coming_soon",
        "archived",
      ],
    },
  },
} as const

